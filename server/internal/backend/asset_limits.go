package backend

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	uploadQuotaWindow       = 24 * time.Hour
	maxUploadsPerWindow     = 40
	maxUploadBytesPerWindow = 100 << 20
	assetSigningWindow      = 10 * time.Minute
	maxPUTsPerSigningWindow = 60
	maxGETsPerSigningWindow = 120
)

// Charge a weighted account quota with the same keyed PostgreSQL counters
// as the existing rate limits. The transaction timestamp keeps multiple
// counters for one upload in the same UTC window. Denials leave capacity
// unchanged, including when a later smaller upload still fits.
func (s *Server) chargeAssetLimit(c *gin.Context, q querier, bucket string, cost, limit int, window time.Duration) error {
	var retryAfter int
	err := q.QueryRow(c.Request.Context(), `WITH period AS (
		SELECT date_bin($2::int * interval '1 second',transaction_timestamp(),
		                timestamptz '2000-01-01 00:00:00+00') AS start
	), accepted AS (
		INSERT INTO auth_rate_limits AS r(key,window_start,count)
		SELECT $1::bytea,start,$3::int FROM period WHERE $3::int <= $4::int
		ON CONFLICT (key) DO UPDATE SET
			window_start=EXCLUDED.window_start,
			count=CASE WHEN r.window_start=EXCLUDED.window_start
			           THEN r.count+EXCLUDED.count ELSE EXCLUDED.count END
		WHERE r.window_start<EXCLUDED.window_start OR
		      (r.window_start=EXCLUDED.window_start AND r.count <= $4::int-EXCLUDED.count)
		RETURNING 1
	)
	SELECT CASE WHEN EXISTS (SELECT FROM accepted) THEN 0 ELSE
	  GREATEST(1,ceil(extract(epoch FROM start + $2::int * interval '1 second' - clock_timestamp()))::int)
	END FROM period`, s.mac("rate", "oss:"+bucket+":"+current(c).User.ID), int(window/time.Second), cost, limit).Scan(&retryAfter)
	if err != nil {
		return err
	}
	if retryAfter != 0 {
		c.Header("Retry-After", strconv.Itoa(retryAfter))
		return problem(429, "rate_limited", "图片存储授权达到额度，请稍后重试。")
	}
	return nil
}
