package backend

import (
	"time"
	_ "time/tzdata" // The API's scratch image has no system timezone database.

	"github.com/gin-gonic/gin"
	"github.com/oapi-codegen/runtime/types"
	"spark/server/internal/contract"
)

func calendarLocation(name string) (*time.Location, error) {
	if name != "" && name != "Local" {
		if location, err := time.LoadLocation(name); err == nil {
			return location, nil
		}
	}
	return nil, problem(400, "invalid_request", "请提供有效的 IANA 时区。")
}

func parseCivilDate(raw string) (time.Time, error) {
	date, err := time.Parse(time.DateOnly, raw)
	if err != nil || date.Year() < 1 {
		return time.Time{}, problem(400, "invalid_request", "请提供有效的当地日期。")
	}
	return date, nil
}

func civilDateAt(now time.Time, location *time.Location) time.Time {
	year, month, day := now.In(location).Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// localDayStart finds the first instant of a civil date from the zone offsets.
// This also handles transitions at midnight and dates skipped in their entirety.
func localDayStart(date time.Time, location *time.Location) (time.Time, error) {
	const (
		offsetWindow = 36 * time.Hour
		maxSegments  = 16
	)
	instant := date.Add(-offsetWindow)
	// The window exceeds the absolute offset of every IANA zone. Cap the
	// number of segments as well so an inconsistent zone cannot stall a request.
	for range maxSegments {
		local := instant.In(location)
		_, offset := local.Zone()
		shift := time.Duration(offset) * time.Second
		if shift <= -offsetWindow || shift >= offsetWindow {
			break
		}
		_, end := local.ZoneBounds()
		if !end.IsZero() && !end.After(instant) {
			// Go's POSIX extension uses Jan 1 + 365 days as a synthetic end
			// after the year's last transition. In leap years it lands on
			// Dec 31. Recheck the zone at the actual UTC year boundary.
			yearStart := time.Date(instant.UTC().Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
			nextYear := yearStart.AddDate(1, 0, 0)
			if !end.Equal(yearStart.Add(365*24*time.Hour)) || !end.Before(nextYear) {
				break
			}
			end = nextYear
		}
		start := date.Add(-shift)
		if start.Before(instant) {
			start = instant
		}
		if end.IsZero() || start.Before(end) {
			start = start.UTC()
			if start.Year() >= 0 && start.Year() <= 9999 {
				return start, nil
			}
			break
		}
		instant = end
	}
	return time.Time{}, problem(400, "invalid_request", "无法表示所选时区的日期边界。")
}

func (s *Server) getActivity(c *gin.Context) (any, error) {
	location, err := calendarLocation(c.Query("tz"))
	if err != nil {
		return nil, err
	}
	from, err := parseCivilDate(c.Query("from"))
	if err != nil {
		return nil, err
	}
	to, err := parseCivilDate(c.Query("to"))
	if err != nil {
		return nil, err
	}
	if !from.Before(to) || to.After(from.AddDate(0, 0, 31)) {
		return nil, problem(400, "invalid_request", "请选择 1 至 31 个当地自然日。")
	}

	result := contract.ActivityResult{From: types.Date{Time: from}, To: types.Date{Time: to}, Tz: location.String()}
	var starts, ends []time.Time
	start, err := localDayStart(from, location)
	if err != nil {
		return nil, err
	}
	for date := from; date.Before(to); {
		next := date.AddDate(0, 0, 1)
		end, err := localDayStart(next, location)
		if err != nil {
			return nil, err
		}
		starts, ends = append(starts, start), append(ends, end)
		result.Days = append(result.Days, contract.ActivityDay{
			Date: types.Date{Time: date}, CreatedFrom: start, CreatedTo: end,
		})
		date, start = next, end
	}
	rows, err := s.Pool.Query(c.Request.Context(), `SELECT counts.total
		FROM unnest($2::timestamptz[], $3::timestamptz[]) WITH ORDINALITY AS day(start_at,end_at,position)
		CROSS JOIN LATERAL (
			SELECT count(*) AS total FROM collections c
			WHERE c.user_id=$1 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL
			  AND c.created_at>=day.start_at AND c.created_at<day.end_at
		) counts ORDER BY day.position`, current(c).User.ID, starts, ends)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for i := 0; rows.Next(); i++ {
		if err := rows.Scan(&result.Days[i].Count); err != nil {
			return nil, err
		}
	}
	return result, rows.Err()
}
