package gui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/google/uuid"
	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/native"
	"spark/apps/desktop/internal/store"
	"spark/apps/desktop/internal/syncer"
)

// Host owns the in-process UI bridge. Every account-bound request carries the
// account displayed when the gesture started so a stale window cannot write to a new account.
type Host struct {
	Rebind     func(string, string) error
	Context    context.Context
	Store      *store.Store
	Sessions   *auth.Sessions
	API        *api.Client
	Engine     *syncer.Engine
	Clipboard  *native.ClipboardTracker
	Action     func(string, string) error
	OpenURL    func(string) error
	Change     func()
	pairMu     sync.Mutex
	pairing    pairStatus
	pairCancel context.CancelFunc
}
type pairStatus struct {
	Status  string    `json:"status"`
	Code    string    `json:"short_code,omitempty"`
	Expires time.Time `json:"expires_at,omitempty"`
	Message string    `json:"message,omitempty"`
}
type response map[string]any
type handler func(http.ResponseWriter, *http.Request) (any, error)
type problem struct {
	status int
	text   string
}

func (p problem) Error() string { return p.text }
func decode(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return problem{400, "请求格式有误或图片过大"}
	}
	return nil
}
func (h *Host) Handler() http.Handler {
	m := http.NewServeMux()
	route := func(pattern string, fn handler) {
		m.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if r.Header.Get("X-Spark-Desktop") != "1" {
				http.Error(w, "请求来源无效", 403)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
			v, err := fn(w, r)
			if err != nil {
				code, msg := 500, "操作未完成，请稍后重试。"
				var p problem
				if errors.As(err, &p) {
					code, msg = p.status, p.text
				} else if ae, ok := api.AsAPIError(err); ok {
					code, msg = ae.Status, ae.Message
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(code)
				_ = json.NewEncoder(w).Encode(response{"message": msg})
				return
			}
			if v == nil {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/local/capture":
				w.WriteHeader(201)
			case "/local/sync/now":
				w.WriteHeader(202)
			}
			_ = json.NewEncoder(w).Encode(v)
		})
	}
	route("GET /local/state", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		sess, _ := h.Sessions.Load()
		counts, err := h.Store.Counts(sess.AccountID)
		if err != nil {
			return nil, err
		}
		h.pairMu.Lock()
		pair := h.pairing
		h.pairMu.Unlock()
		return response{"session": sess.Public(time.Now()), "counts": counts, "pair": pair, "origin": h.API.BaseURL(), "palette": h.Store.GetPref("palette", "mint"), "mode": h.Store.GetPref("mode", "system"), "capture_key": h.Store.GetPref("capture_key", "Option+Space"), "screenshot_key": h.Store.GetPref("screenshot_key", "Option+Shift+4")}, nil
	})
	route("POST /local/pair/start", h.startPair)
	accountRoute := func(pattern string, fn func(auth.StoredSession, *http.Request) (any, error)) {
		route(pattern, func(_ http.ResponseWriter, r *http.Request) (any, error) {
			s, err := h.Sessions.Load()
			if err != nil || r.Header.Get("X-Spark-Account") != s.AccountID {
				return nil, problem{409, "账号已切换，请重新打开此页面。"}
			}
			return fn(s, r)
		})
	}
	accountRoute("POST /local/session/disconnect", func(s auth.StoredSession, r *http.Request) (any, error) {
		h.pairMu.Lock()
		defer h.pairMu.Unlock()
		current, err := h.Sessions.Load()
		if err != nil || current.Token != s.Token {
			return nil, problem{409, "配对状态已变化"}
		}
		if err := h.API.RevokeDesktopSession(r.Context(), s.Token); err != nil {
			if ae, ok := api.AsAPIError(err); !ok || ae.Status != 401 {
				return nil, err
			}
		}
		if h.pairCancel != nil {
			h.pairCancel()
		}
		h.pairing = pairStatus{}
		err = h.Sessions.Clear()
		h.Change()
		return nil, err
	})
	accountRoute("POST /local/capture", func(s auth.StoredSession, r *http.Request) (any, error) {
		var req struct {
			RawText     string   `json:"raw_text"`
			Intent      string   `json:"intent"`
			OriginalURL string   `json:"original_url"`
			SuppressURL bool     `json:"suppress_url"`
			ManualTitle string   `json:"manual_title"`
			ProjectIDs  []string `json:"project_ids"`
			TagIDs      []string `json:"tag_ids"`
			Attachments []struct {
				Filename string `json:"filename"`
				Data     []byte `json:"data_b64"`
			} `json:"attachments"`
		}
		if err := decode(r, &req); err != nil {
			return nil, err
		}
		in := store.EnqueueInput{AccountID: s.AccountID, RawText: req.RawText, Intent: req.Intent, OriginalURL: req.OriginalURL, SuppressURL: req.SuppressURL, ManualTitle: req.ManualTitle, ProjectIDs: req.ProjectIDs, TagIDs: req.TagIDs}
		for _, f := range req.Attachments {
			in.Attachments = append(in.Attachments, store.PendingAttachmentInput{Filename: f.Filename, Data: f.Data})
		}
		item, err := h.Capture(in)
		return response{"item": item}, err
	})
	accountRoute("GET /local/outbox", func(s auth.StoredSession, r *http.Request) (any, error) { return h.Store.ListPending(s.AccountID) })
	accountRoute("DELETE /local/outbox/{id}", func(s auth.StoredSession, r *http.Request) (any, error) {
		err := h.Store.DeleteOutboxItem(s.AccountID, r.PathValue("id"))
		if err == nil {
			h.Change()
		}
		return nil, err
	})
	accountRoute("GET /local/projects", func(s auth.StoredSession, r *http.Request) (any, error) {
		return h.Store.ListCachedProjects(s.AccountID)
	})
	accountRoute("GET /local/tags", func(s auth.StoredSession, r *http.Request) (any, error) { return h.Store.ListCachedTags(s.AccountID) })
	accountRoute("GET /local/search/local", func(s auth.StoredSession, r *http.Request) (any, error) {
		q := r.URL.Query().Get("q")
		n := 30
		if q == "" {
			n = 6
		}
		return h.Store.SearchLocal(s.AccountID, q, n)
	})
	accountRoute("GET /local/search/remote", func(s auth.StoredSession, r *http.Request) (any, error) {
		return h.API.SearchCollections(r.Context(), s.Token, r.URL.Query().Get("q"), "", "", "", 30)
	})
	accountRoute("GET /local/collections", func(s auth.StoredSession, r *http.Request) (any, error) {
		return h.Store.ListCachedCollections(s.AccountID, r.URL.Query().Get("project_id"), 100)
	})
	accountRoute("GET /local/collections/page", func(s auth.StoredSession, r *http.Request) (any, error) {
		q := r.URL.Query()
		p, err := h.API.ListCollections(r.Context(), s.Token, "active", q.Get("project_id"), q.Get("tag_id"), q.Get("cursor"), 40)
		if err == nil {
			err = h.Store.UpsertCachedCollections(s.AccountID, p.Items)
		}
		return p, err
	})
	accountRoute("GET /local/collections/{id}", func(s auth.StoredSession, r *http.Request) (any, error) {
		id := r.PathValue("id")
		if _, err := uuid.Parse(id); err != nil {
			return nil, problem{400, "收藏编号无效"}
		}
		item, found, err := h.Store.GetOutboxItem(s.AccountID, id)
		if err != nil {
			return nil, err
		}
		if found && item.State != store.OutboxSynced {
			return response{"item": item}, nil
		}
		c, err := h.API.GetCollection(r.Context(), s.Token, id)
		if err == nil {
			err = h.Store.UpsertCachedCollectionDetail(s.AccountID, c)
			return response{"collection": c}, err
		}
		if ae, ok := api.AsAPIError(err); ok && ae.Status != 429 && ae.Status < 500 {
			return nil, err
		}
		cached, ok, e := h.Store.GetCachedCollectionDetail(s.AccountID, id)
		if e == nil && ok {
			return response{"collection": cached, "offline": true}, nil
		}
		return nil, err
	})
	accountRoute("GET /local/image/{id}", func(s auth.StoredSession, r *http.Request) (any, error) {
		id := r.PathValue("id")
		if _, e := uuid.Parse(id); e != nil {
			return nil, problem{400, "图片编号无效"}
		}
		if owner := r.URL.Query().Get("outbox"); owner != "" {
			item, _, err := h.Store.GetOutboxItem(s.AccountID, owner)
			if err != nil {
				return nil, err
			}
			for _, a := range item.Attachments {
				if a.ID == id {
					raw, e := h.Store.ReadAttachmentBytes(a)
					return response{"mime": a.MimeType, "data": raw}, e
				}
			}
			return nil, problem{404, "图片不存在"}
		}
		b, mime, err := h.API.GetAttachmentThumbnail(r.Context(), s.Token, id)
		return response{"mime": mime, "data": b}, err
	})
	accountRoute("POST /local/sync/now", func(s auth.StoredSession, r *http.Request) (any, error) {
		h.Engine.Trigger()
		return response{}, h.Engine.RefreshRemoteCache(r.Context())
	})
	route("POST /local/window/{action}", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		id := r.URL.Query().Get("id")
		if id != "" {
			if _, e := uuid.Parse(id); e != nil {
				return nil, problem{400, "编号无效"}
			}
		}
		switch act := r.PathValue("action"); act {
		case "hide", "main", "panel", "screenshot", "settings", "resize":
			if act == "resize" {
				id = r.URL.Query().Get("height")
			}
			return nil, h.Action(act, id)
		case "web":
			path := "/inbox"
			if id != "" {
				path = "/collections/" + id
			}
			return nil, h.OpenURL(h.API.BaseURL() + path)
		}
		return nil, problem{404, "未知操作"}
	})
	route("PUT /local/shortcut", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var v struct{ Key, Value string }
		if err := decode(r, &v); err != nil {
			return nil, err
		}
		allowed := map[string][]string{"capture": {"Option+Space", "Control+Option+Space", "Command+Shift+Space"}, "screenshot": {"Option+Shift+4", "Control+Option+4", "Command+Shift+5"}}
		if !slices.Contains(allowed[v.Key], v.Value) {
			return nil, problem{422, "快捷键无效"}
		}
		if err := h.Rebind(v.Key, v.Value); err != nil {
			return nil, problem{409, err.Error()}
		}
		h.Change()
		return nil, nil
	})
	accountRoute("POST /local/clipboard/copy-image", func(s auth.StoredSession, r *http.Request) (any, error) {
		id := r.URL.Query().Get("id")
		if uuid.Validate(id) != nil {
			return nil, problem{400, "收藏编号无效"}
		}
		item, ok, err := h.Store.GetOutboxItem(s.AccountID, id)
		if err != nil {
			return nil, err
		}
		var data []byte
		if ok && item.State != store.OutboxSynced && len(item.Attachments) > 0 {
			data, err = h.Store.ReadAttachmentBytes(item.Attachments[0])
		} else {
			col, e := h.API.GetCollection(r.Context(), s.Token, id)
			if e != nil {
				return nil, e
			}
			if len(col.Attachments) == 0 {
				return nil, problem{404, "没有可复制的图片"}
			}
			data, err = h.API.OriginalImage(r.Context(), s.Token, col.Attachments[0].ID)
		}
		if err != nil {
			return nil, err
		}
		if _, _, err = api.ValidateImageBytes(data, "image"); err != nil {
			return nil, err
		}
		return nil, native.CopyImage(data)
	})
	route("PUT /local/prefs", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var req struct{ Palette, Mode string }
		if err := decode(r, &req); err != nil {
			return nil, err
		}
		if !slices.Contains([]string{"mint", "sea", "matcha", "sakura"}, req.Palette) || !slices.Contains([]string{"system", "light", "dark"}, req.Mode) {
			return nil, problem{422, "外观选项无效"}
		}
		if err := h.Store.SetPref("palette", req.Palette); err != nil {
			return nil, err
		}
		err := h.Store.SetPref("mode", req.Mode)
		h.Change()
		return nil, err
	})
	route("GET /local/clipboard", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		v, _, ok := h.Clipboard.FreshSample(time.Now())
		if !ok || v.ChangeCount != native.ClipboardCount() {
			return response{"available": false}, nil
		}
		return response{"available": true, "text": v.Text, "image": v.ImagePNG}, nil
	})
	route("POST /local/clipboard/dismiss", func(_ http.ResponseWriter, r *http.Request) (any, error) { h.Clipboard.Dismiss(); return nil, nil })
	route("POST /local/clipboard/copy", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var v struct{ Text string }
		if err := decode(r, &v); err != nil {
			return nil, err
		}
		native.CopyTextToClipboard(v.Text)
		return nil, nil
	})
	return m
}

func (h *Host) Capture(in store.EnqueueInput) (store.OutboxItem, error) {
	if err := api.ValidateCaptureInput(in.RawText, in.Intent, in.OriginalURL, len(in.Attachments)); err != nil {
		return store.OutboxItem{}, problem{422, err.Error()}
	}
	for _, a := range in.Attachments {
		if _, _, err := api.ValidateImageBytes(a.Data, a.Filename); err != nil {
			return store.OutboxItem{}, problem{422, err.Error()}
		}
	}
	s, err := h.Sessions.Load()
	if err != nil || s.AccountID != in.AccountID {
		return store.OutboxItem{}, problem{409, "请先连接当前账号"}
	}
	item, err := h.Store.EnqueueCapture(in, time.Now())
	if err == nil {
		h.Engine.Trigger()
		h.Change()
	}
	return item, err
}
func (h *Host) startPair(_ http.ResponseWriter, r *http.Request) (any, error) {
	h.pairMu.Lock()
	defer h.pairMu.Unlock()
	s, _ := h.Sessions.Load()
	if s.Public(time.Now()).Connected {
		return nil, problem{409, "此设备已连接"}
	}
	pair, err := auth.NewPairRequest(time.Now())
	if err != nil {
		return nil, err
	}
	u, err := auth.BuildPairURL(h.API.BaseURL(), pair.Challenge)
	if err != nil {
		return nil, err
	}
	if err = h.OpenURL(u); err != nil {
		return nil, err
	}
	if h.pairCancel != nil {
		h.pairCancel()
	}
	ctx, cancel := context.WithDeadline(h.Context, pair.ExpiresAt)
	h.pairCancel = cancel
	h.pairing = pairStatus{"pending", pair.ShortCode, pair.ExpiresAt, ""}
	go h.pollPair(ctx, pair)
	return h.pairing, nil
}
func (h *Host) pollPair(ctx context.Context, p auth.PairRequest) {
	timer := time.NewTicker(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			h.pairMu.Lock()
			if h.pairing.Code == p.ShortCode && h.pairing.Status == "pending" {
				h.pairing.Status = "expired"
			}
			h.pairMu.Unlock()
			h.Change()
			return
		case <-timer.C:
		}
		v, err := h.API.ExchangeDesktopToken(ctx, p.Verifier)
		if err != nil {
			ae, ok := api.AsAPIError(err)
			if !ok || ae.Status == 429 || ae.Status >= 500 || ae.Code == "desktop_grant_pending" {
				continue
			}
		}
		h.pairMu.Lock()
		if ctx.Err() != nil || h.pairing.Code != p.ShortCode {
			h.pairMu.Unlock()
			return
		}
		if err == nil {
			if !auth.IsValidSecret(v.Token) || uuid.Validate(v.AccountID) != nil || !v.ExpiresAt.After(time.Now()) {
				err = errors.New("无效的设备会话")
			} else {
				err = h.Sessions.Save(auth.StoredSession{Token: v.Token, AccountID: v.AccountID, AccountLabel: v.AccountLabel, ExpiresAt: v.ExpiresAt})
				if err == nil {
					err = h.Store.ResumeAuthPaused(v.AccountID, time.Now())
					h.Engine.Trigger()
				}
			}
		}
		if err != nil {
			h.pairing = pairStatus{Status: "invalid", Message: "配对未完成，请重新连接。"}
		} else {
			h.pairing = pairStatus{Status: "connected"}
		}
		h.pairMu.Unlock()
		h.Change()
		return
	}
}
