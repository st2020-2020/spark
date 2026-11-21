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
func localDayStart(date time.Time, location *time.Location) time.Time {
	for instant := date.Add(-36 * time.Hour); ; {
		local := instant.In(location)
		_, offset := local.Zone()
		_, end := local.ZoneBounds()
		start := date.Add(-time.Duration(offset) * time.Second)
		if start.Before(instant) {
			start = instant
		}
		if end.IsZero() || start.Before(end) {
			return start.UTC()
		}
		instant = end
	}
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
	start := localDayStart(from, location)
	for date := from; date.Before(to); {
		next := date.AddDate(0, 0, 1)
		end := localDayStart(next, location)
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
