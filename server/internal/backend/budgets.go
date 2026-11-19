package backend

import (
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
	"time"
)

var budgetLocation = time.FixedZone("Asia/Shanghai", 8*3600)

func budgetDay() string { return time.Now().In(budgetLocation).Format("2006-01-02") }
func loadBudgetConfig(ctx context.Context, q querier) (contract.BudgetConfig, error) {
	var out contract.BudgetConfig
	err := q.QueryRow(ctx, `SELECT version,platform_daily_units,user_daily_units,worker_concurrency FROM ai_budget_config WHERE singleton`).Scan(&out.Version, &out.PlatformDailyUnits, &out.UserDailyUnits, &out.WorkerConcurrency)
	return out, err
}
func (s *Server) getBudgets(c *gin.Context) (any, error) {
	return loadBudgetConfig(c.Request.Context(), s.Pool)
}
func (s *Server) setBudgets(c *gin.Context) (any, error) {
	req, err := bind[contract.BudgetUpdate](s, c)
	if err != nil {
		return nil, err
	}
	if req.PlatformDailyUnits > 1000000000000 || req.UserDailyUnits > 1000000000000 {
		return nil, problem(422, "validation_failed", "额度超出支持范围。")
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var version int
	if err = tx.QueryRow(ctx, `SELECT version FROM ai_budget_config WHERE singleton FOR UPDATE`).Scan(&version); err != nil {
		return nil, err
	}
	if version != req.BaseVersion {
		return nil, conflict("resource_conflict", "current_version", int64(version))
	}
	if _, err = tx.Exec(ctx, `UPDATE ai_budget_config SET version=version+1,platform_daily_units=$1,user_daily_units=$2,worker_concurrency=$3 WHERE singleton`, req.PlatformDailyUnits, req.UserDailyUnits, req.WorkerConcurrency); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO admin_audit(id,actor_id,action,target_type,safe_metadata) VALUES($1,$2,'update_budgets','budget_config',$3)`, uuid.NewString(), current(c).User.ID, jsonBytes(req)); err != nil {
		return nil, err
	}
	out, err := loadBudgetConfig(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
func (s *Server) getUsage(c *gin.Context) (any, error) {
	cfg, err := loadBudgetConfig(c.Request.Context(), s.Pool)
	if err != nil {
		return nil, err
	}
	var reserved, settled int64
	err = s.Pool.QueryRow(c.Request.Context(), `SELECT reserved_units,settled_units FROM daily_budgets WHERE scope='user' AND owner_key=$1 AND budget_day=$2::date`, current(c).User.ID, budgetDay()).Scan(&reserved, &settled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return gin.H{"budget_day": budgetDay(), "timezone": "Asia/Shanghai", "limit_units": cfg.UserDailyUnits, "reserved_units": reserved, "settled_units": settled, "blocked": reserved+settled >= int64(cfg.UserDailyUnits)}, nil
}
func budgetAvailable(ctx context.Context, q querier, uid string) (bool, error) {
	cfg, err := loadBudgetConfig(ctx, q)
	if err != nil {
		return false, err
	}
	var platform, user int64
	err = q.QueryRow(ctx, `SELECT COALESCE(sum(reserved_units+settled_units) FILTER(WHERE scope='platform'),0),COALESCE(sum(reserved_units+settled_units) FILTER(WHERE scope='user' AND owner_key=$1),0) FROM daily_budgets WHERE budget_day=$2::date AND ((scope='platform' AND owner_key='platform') OR (scope='user' AND owner_key=$1))`, uid, budgetDay()).Scan(&platform, &user)
	return cfg.PlatformDailyUnits > 0 && cfg.UserDailyUnits > 0 && platform < int64(cfg.PlatformDailyUnits) && user < int64(cfg.UserDailyUnits), err
}
func lockBudgetRows(ctx context.Context, tx pgx.Tx, uid, day string) error {
	for _, v := range []struct{ scope, owner string }{{"platform", "platform"}, {"user", uid}} {
		if _, err := tx.Exec(ctx, `INSERT INTO daily_budgets(scope,owner_key,budget_day) VALUES($1,$2,$3::date) ON CONFLICT DO NOTHING`, v.scope, v.owner, day); err != nil {
			return err
		}
		var locked int64
		if err := tx.QueryRow(ctx, `SELECT reserved_units FROM daily_budgets WHERE scope=$1 AND owner_key=$2 AND budget_day=$3::date FOR UPDATE`, v.scope, v.owner, day).Scan(&locked); err != nil {
			return err
		}
	}
	return nil
}

// A pending reservation from a crashed process is uncertain, never a free retry.
func reserveBudget(ctx context.Context, tx pgx.Tx, uid, run string, route AIRoute, cfg AIConfig, inputUpper int64) (string, string, error) {
	var stale string
	err := tx.QueryRow(ctx, `SELECT id FROM usage_reservations WHERE user_id=$1 AND run_id=$2 AND state IN ('reserved','uncertain') LIMIT 1`, uid, run).Scan(&stale)
	if err == nil {
		if _, err = tx.Exec(ctx, `UPDATE usage_reservations SET state='uncertain',error_code='usage_uncertain',updated_at=now() WHERE id=$1`, stale); err != nil {
			return "", "", err
		}
		return "", "usage_uncertain", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	upper, err := tokenCost(route, inputUpper, int64(route.MaxOutputTokens))
	if err != nil {
		return "", "", err
	}
	day, err := budgetDayWithCapacity(ctx, tx, uid, upper)
	if err != nil {
		return "", "", err
	}
	if day == "" {
		return "", "quota_exceeded", nil
	}
	var attempt int
	if err = tx.QueryRow(ctx, `UPDATE organization_runs SET attempts=attempts+1,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING attempts`, uid, run).Scan(&attempt); err != nil {
		return "", "", err
	}
	id := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO usage_reservations(id,user_id,run_id,attempt_no,budget_day,route,config_version,model,reserved_units,state) VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,'reserved')`, id, uid, run, attempt, day, route.Name, cfg.Version, route.Model, upper); err != nil {
		return "", "", err
	}
	return id, "", addBudgetReservation(ctx, tx, uid, day, upper)
}

// Both types of jobs lock platform before account and use the same daily
// counters and limits. Empty day means a reservation would exceed a limit.
func budgetDayWithCapacity(ctx context.Context, tx pgx.Tx, uid string, upper int64) (string, error) {
	var platformLimit, userLimit int64
	if err := tx.QueryRow(ctx, `SELECT platform_daily_units,user_daily_units FROM ai_budget_config WHERE singleton FOR SHARE`).Scan(&platformLimit, &userLimit); err != nil {
		return "", err
	}
	if platformLimit == 0 || userLimit == 0 || upper > platformLimit || upper > userLimit {
		return "", nil
	}
	day := budgetDay()
	if err := lockBudgetRows(ctx, tx, uid, day); err != nil {
		return "", err
	}
	var platformUsed, userUsed int64
	if err := tx.QueryRow(ctx, `SELECT reserved_units+settled_units FROM daily_budgets WHERE scope='platform' AND owner_key='platform' AND budget_day=$1::date`, day).Scan(&platformUsed); err != nil {
		return "", err
	}
	if err := tx.QueryRow(ctx, `SELECT reserved_units+settled_units FROM daily_budgets WHERE scope='user' AND owner_key=$1 AND budget_day=$2::date`, uid, day).Scan(&userUsed); err != nil {
		return "", err
	}
	if upper > platformLimit-platformUsed || upper > userLimit-userUsed {
		return "", nil
	}
	return day, nil
}

func addBudgetReservation(ctx context.Context, tx pgx.Tx, uid, day string, upper int64) error {
	_, err := tx.Exec(ctx, `UPDATE daily_budgets SET reserved_units=reserved_units+$3
		WHERE budget_day=$2::date AND ((scope='platform' AND owner_key='platform') OR (scope='user' AND owner_key=$1))`, uid, day, upper)
	return err
}
func settleBudget(ctx context.Context, tx pgx.Tx, uid, id string, route AIRoute, out ModelOutput, expectedState string) error {
	var day, state string
	var reserved int64
	if err := tx.QueryRow(ctx, `SELECT budget_day::text,reserved_units,state FROM usage_reservations WHERE user_id=$1 AND id=$2`, uid, id).Scan(&day, &reserved, &state); err != nil {
		return err
	}
	if state != expectedState {
		return nil
	}
	if err := lockBudgetRows(ctx, tx, uid, day); err != nil {
		return err
	}
	next := "uncertain"
	actual := int64(0)
	if out.Usage != nil {
		var err error
		actual, err = tokenCost(route, out.Usage.Input, out.Usage.Output)
		if err != nil {
			return err
		}
		next = "settled"
	} else if !out.Sent || out.SafeFailure {
		next = "released"
	}
	if next != "uncertain" {
		if _, err := tx.Exec(ctx, `UPDATE daily_budgets SET reserved_units=reserved_units-$3,settled_units=settled_units+$4 WHERE budget_day=$2::date AND ((scope='platform' AND owner_key='platform') OR (scope='user' AND owner_key=$1))`, uid, day, reserved, actual); err != nil {
			return err
		}
	}
	var input, output any
	if out.Usage != nil {
		input = out.Usage.Input
		output = out.Usage.Output
	}
	var amount any
	if next == "settled" {
		amount = actual
	}
	_, err := tx.Exec(ctx, `UPDATE usage_reservations SET state=$3,actual_units=$4,input_tokens=$5,output_tokens=$6,error_code=NULLIF($7,''),model=COALESCE(NULLIF($8,''),model),updated_at=now() WHERE user_id=$1 AND id=$2 AND state=$9`, uid, id, next, amount, input, output, out.ErrorCode, out.Model, expectedState)
	return err
}
