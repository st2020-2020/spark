package backend

import (
	"context"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

const (
	mailQueue       = "mail_delivery"
	mailJobAttempts = 3
	mailBurstLimit  = 20
	mailDailyLimit  = 120
	mailMinimumLife = 15 * time.Second
)

type challengeMail struct {
	Adapter     string    `json:"adapter"`
	ChallengeID string    `json:"challenge_id"`
	Email       string    `json:"email"`
	Purpose     string    `json:"purpose"`
	Code        string    `json:"verification_code"`
	ExpiresAt   time.Time `json:"expires_at"`
}

type mailJobArgs struct {
	ChallengeID string `json:"challenge_id"`
}

func (mailJobArgs) Kind() string { return "spark_send_mail" }

func enqueueMail(ctx context.Context, tx pgx.Tx, queue *river.Client[pgx.Tx], challengeID string) error {
	_, err := queue.InsertTx(ctx, tx, mailJobArgs{ChallengeID: challengeID}, &river.InsertOpts{
		Queue: mailQueue, MaxAttempts: mailJobAttempts,
		UniqueOpts: river.UniqueOpts{ByArgs: true},
	})
	return err
}

func (s *Server) reserveMailChallenge(c *gin.Context, tx pgx.Tx) error {
	for _, cap := range []struct {
		name   string
		limit  int
		window time.Duration
	}{{"mail:daily", mailDailyLimit, 24 * time.Hour}, {"mail:burst", mailBurstLimit, 10 * time.Minute}} {
		// Shared across replicas and secret rotation. These are two fixed
		// platform counter keys, with no email or client identifiers.
		retry, err := reserveRateCapacity(c.Request.Context(), tx, digest(cap.name), 1, cap.limit, cap.window)
		if err != nil {
			return err
		}
		if retry > 0 {
			c.Header("Retry-After", strconv.Itoa(retry))
			return problem(429, "rate_limited", "验证码邮件申请过多，请稍后再试。")
		}
	}
	return nil
}
