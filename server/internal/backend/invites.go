package backend

import (
	"context"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

var invitePattern = regexp.MustCompile(`^[A-Za-z0-9-]{12,64}$`)

type importRow struct {
	Code    string     `json:"code"`
	Expires *time.Time `json:"expires_at,omitempty"`
}
type importError struct {
	Row     int    `json:"row"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type preview struct {
	ID        string        `json:"id"`
	ValidRows int           `json:"valid_rows"`
	Errors    []importError `json:"errors"`
	Expires   time.Time     `json:"expires_at"`
}

func (s *Server) previewInvites(c *gin.Context) (any, error) {
	req, err := bind[contract.InvitePreviewRequest](s, c)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Name) == "" {
		return nil, problem(422, "validation_failed", "请填写批次名称。")
	}
	return s.idempotent(c, req, 201, func(tx pgx.Tx) (any, error) {
		r := csv.NewReader(strings.NewReader(strings.TrimPrefix(req.Csv, "\ufeff")))
		r.FieldsPerRecord = -1
		header, err := r.Read()
		if err != nil || len(header) != 3 || strings.Join(header, ",") != "code,expires_at,max_uses" {
			return nil, problem(422, "validation_failed", "CSV 表头应为 code,expires_at,max_uses。")
		}
		out := preview{ID: uuid.NewString(), Errors: []importError{}, Expires: time.Now().UTC().Add(30 * time.Minute)}
		parsed := []importRow{}
		seen := map[string]bool{}
		digests := [][]byte{}
		lineForDigest := map[string]int{}
		for line := 2; ; line++ {
			cols, e := r.Read()
			if e == io.EOF {
				break
			}
			if line > 1001 {
				return nil, problem(422, "validation_failed", "每批最多导入 1,000 行。")
			}
			if e != nil {
				out.Errors = append(out.Errors, importError{line, "invalid_row", "CSV 行格式错误。"})
				break
			}
			row := importRow{}
			if len(cols) != 3 {
				out.Errors = append(out.Errors, importError{line, "invalid_row", "每行必须包含三列。"})
				continue
			}
			row.Code = strings.TrimSpace(cols[0])
			valid := true
			if !invitePattern.MatchString(row.Code) {
				out.Errors = append(out.Errors, importError{line, "invalid_code", "邀请码须为 12 至 64 位 ASCII 字母、数字或连字符。"})
				valid = false
			}
			if seen[row.Code] {
				out.Errors = append(out.Errors, importError{line, "duplicate_code", "批次内存在重复邀请码。"})
				valid = false
			}
			seen[row.Code] = true
			if strings.TrimSpace(cols[2]) != "1" {
				out.Errors = append(out.Errors, importError{line, "invalid_max_uses", "本批次只接受一码一人，max_uses 应为 1。"})
				valid = false
			}
			if expires := strings.TrimSpace(cols[1]); expires != "" {
				t, e := time.Parse(time.RFC3339, expires)
				if e != nil || !t.After(time.Now()) {
					out.Errors = append(out.Errors, importError{line, "invalid_expiry", "到期时间须为未来的 RFC3339 时间。"})
					valid = false
				} else {
					row.Expires = &t
				}
			}
			if valid {
				parsed = append(parsed, row)
				d := s.mac("invite", row.Code)
				digests = append(digests, d)
				lineForDigest[hex.EncodeToString(d)] = line
			}
		}
		if len(parsed) == 0 && len(out.Errors) == 0 {
			out.Errors = append(out.Errors, importError{2, "empty_import", "请提供至少一个邀请码。"})
		}
		rows, err := tx.Query(c.Request.Context(), `SELECT encode(code_digest,'hex') FROM invite_codes WHERE code_digest=ANY($1::bytea[])`, digests)
		if err != nil {
			return nil, err
		}
		duplicates := 0
		for rows.Next() {
			var d string
			if err = rows.Scan(&d); err != nil {
				rows.Close()
				return nil, err
			}
			out.Errors = append(out.Errors, importError{lineForDigest[d], "duplicate_code", "邀请码已存在。"})
			duplicates++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		out.ValidRows = len(parsed) - duplicates
		encrypted, err := s.seal("invite:"+out.ID, jsonBytes(parsed))
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(c.Request.Context(), `INSERT INTO invite_imports(id,admin_id,name,payload_digest,encrypted_rows,validation_result,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, out.ID, current(c).User.ID, req.Name, digest(req.Csv), encrypted, jsonBytes(out), out.Expires); err != nil {
			return nil, err
		}
		return out, nil
	})
}
func (s *Server) commitInvites(c *gin.Context) (any, error) {
	return s.idempotent(c, nil, 201, func(tx pgx.Tx) (any, error) {
		ctx := c.Request.Context()
		uid, id := current(c).User.ID, c.Param("id")
		var name, state string
		var encrypted, validation []byte
		var expires time.Time
		var batch *string
		err := tx.QueryRow(ctx, `SELECT name,state,encrypted_rows,validation_result,expires_at,batch_id FROM invite_imports WHERE admin_id=$1 AND id=$2 FOR UPDATE`, uid, id).Scan(&name, &state, &encrypted, &validation, &expires, &batch)
		if err != nil {
			return nil, err
		}
		if state == "committed" && batch != nil {
			return loadBatch(ctx, tx, *batch)
		}
		if state != "preview" || !expires.After(time.Now()) {
			return nil, problem(410, "import_expired", "导入预览已过期，请重新预览。")
		}
		var p preview
		if err = json.Unmarshal(validation, &p); err != nil {
			return nil, err
		}
		if len(p.Errors) > 0 {
			return nil, problem(422, "validation_failed", "请修正预览中的所有错误后重新导入。")
		}
		decrypted, err := s.open("invite:"+id, encrypted)
		if err != nil {
			return nil, err
		}
		var imports []importRow
		if err = json.Unmarshal(decrypted, &imports); err != nil {
			return nil, err
		}
		batchID := uuid.NewString()
		if _, err = tx.Exec(ctx, `INSERT INTO invite_batches(id,name,created_by) VALUES($1,$2,$3)`, batchID, name, uid); err != nil {
			return nil, err
		}
		for _, row := range imports {
			if row.Expires != nil && !row.Expires.After(time.Now()) {
				return nil, problem(409, "invite_unavailable", "预览中存在已过期的邀请码，请重新预览。")
			}
			if _, err = tx.Exec(ctx, `INSERT INTO invite_codes(id,batch_id,code_digest,expires_at) VALUES($1,$2,$3,$4)`, uuid.NewString(), batchID, s.mac("invite", row.Code), row.Expires); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE invite_imports SET state='committed',batch_id=$3,encrypted_rows=NULL WHERE admin_id=$1 AND id=$2`, uid, id, batchID); err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, uid, "invite_import", "invite_batch", batchID); err != nil {
			return nil, err
		}
		return loadBatch(ctx, tx, batchID)
	})
}

const batchSelect = `SELECT b.id,b.name,b.status,b.created_at,count(c.id),count(c.id) FILTER(WHERE c.used_count>0) FROM invite_batches b LEFT JOIN invite_codes c ON c.batch_id=b.id `

func scanBatch(row pgx.Row) (contract.InviteBatch, error) {
	var b contract.InviteBatch
	err := row.Scan(&b.Id, &b.Name, &b.Status, &b.CreatedAt, &b.TotalCodes, &b.UsedCodes)
	return b, err
}
func loadBatch(ctx context.Context, q querier, id string) (contract.InviteBatch, error) {
	return scanBatch(q.QueryRow(ctx, batchSelect+`WHERE b.id=$1 GROUP BY b.id`, id))
}
func audit(ctx context.Context, tx pgx.Tx, uid, action, kind, id string) error {
	_, err := tx.Exec(ctx, `INSERT INTO admin_audit(id,actor_id,action,target_type,target_id) VALUES($1,$2,$3,$4,$5)`, uuid.NewString(), uid, action, kind, id)
	return err
}
func (s *Server) batchStatus(c *gin.Context) (any, error) {
	req, err := bind[contract.BatchStatus](s, c)
	if err != nil {
		return nil, err
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	defer tx.Rollback(ctx)
	id := c.Param("id")
	tag, err := tx.Exec(ctx, `UPDATE invite_batches SET status=$2 WHERE id=$1`, id, string(req.Status))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, notFound
	}
	if err = audit(ctx, tx, current(c).User.ID, "invite_batch_"+string(req.Status), "invite_batch", id); err != nil {
		return nil, err
	}
	result, err := loadBatch(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Server) listBatches(c *gin.Context) (any, error) {
	limit, cur, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	var t, id any
	if cur != nil {
		t = cur.Time
		id = cur.ID
	}
	rows, err := s.Pool.Query(c.Request.Context(), batchSelect+`WHERE ($1::timestamptz IS NULL OR (b.created_at,b.id)<($1,$2::uuid)) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC LIMIT $3`, t, id, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []contract.InviteBatch{}
	for rows.Next() {
		v, e := scanBatch(rows)
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := contract.InviteBatchPage{Items: items}
	if len(items) > limit {
		out.Items = items[:limit]
		v := items[limit-1]
		next := s.nextCursor(c, v.CreatedAt, v.Id.String())
		out.NextCursor = &next
	}
	return out, nil
}
func scanCode(row pgx.Row) (contract.InviteCode, time.Time, error) {
	var v contract.InviteCode
	var created time.Time
	err := row.Scan(&v.Id, &v.BatchId, &v.MaxUses, &v.UsedCount, &v.Disabled, &v.ExpiresAt, &created)
	return v, created, err
}

const codeSelect = `SELECT id,batch_id,max_uses,used_count,disabled_at IS NOT NULL,expires_at,created_at FROM invite_codes `

func (s *Server) codeStatus(c *gin.Context) (any, error) {
	req, err := bind[contract.CodeStatus](s, c)
	if err != nil {
		return nil, err
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	defer tx.Rollback(ctx)
	id := c.Param("id")
	var batch string
	err = tx.QueryRow(ctx, `SELECT batch_id FROM invite_codes WHERE id=$1`, id).Scan(&batch)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `SELECT id FROM invite_batches WHERE id=$1 FOR UPDATE`, batch); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE invite_codes SET disabled_at=CASE WHEN $2 THEN COALESCE(disabled_at,now()) ELSE NULL END WHERE id=$1`, id, req.Disabled); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, current(c).User.ID, "invite_code_status", "invite_code", id); err != nil {
		return nil, err
	}
	result, _, err := scanCode(tx.QueryRow(ctx, codeSelect+`WHERE id=$1`, id))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Server) listCodes(c *gin.Context) (any, error) {
	if _, err := loadBatch(c.Request.Context(), s.Pool, c.Param("id")); err != nil {
		return nil, err
	}
	limit, cur, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	var t, id any
	if cur != nil {
		t = cur.Time
		id = cur.ID
	}
	rows, err := s.Pool.Query(c.Request.Context(), codeSelect+`WHERE batch_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`, c.Param("id"), t, id, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := contract.InviteCodePage{Items: []contract.InviteCode{}}
	var lastTime time.Time
	for rows.Next() {
		v, created, e := scanCode(rows)
		if e != nil {
			return nil, e
		}
		if len(out.Items) == limit {
			last := out.Items[limit-1]
			next := s.nextCursor(c, lastTime, last.Id.String())
			out.NextCursor = &next
			break
		}
		out.Items = append(out.Items, v)
		lastTime = created
	}
	return out, rows.Err()
}

// Maintenance removes expired secrets and bounded-retention operational rows.
// Run explicitly from the operator command, never against a different database.
func (s *Server) Maintenance(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, stmt := range []string{`UPDATE mail_outbox SET encrypted_payload=NULL WHERE expires_at<=now() AND encrypted_payload IS NOT NULL`, `UPDATE invite_imports SET encrypted_rows=NULL,state='expired' WHERE expires_at<=now() AND state='preview'`, `DELETE FROM auth_rate_limits WHERE window_start<now()-interval '1 day'`, `DELETE FROM idempotency_keys WHERE expires_at<=now()`} {
		if _, err = tx.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
