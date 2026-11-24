package gui

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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
	Captures     CaptureTasks
	CopyText     func(string) bool
	Rebind       func(string, string) error
	Store        *store.Store
	Sessions     *auth.Sessions
	API          *api.Client
	Engine       *syncer.Engine
	Clipboard    *native.ClipboardTracker
	PanelVisible func() bool
	Action       func(string, string) error
	OpenURL      func(string) error
	Change       func()
	sessionMu    sync.Mutex
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
		return response{"session": sess.Public(time.Now()), "counts": counts, "origin": h.API.BaseURL(), "palette": h.Store.GetPref("palette", "mint"), "mode": h.Store.GetPref("mode", "system"), "capture_key": h.Store.GetPref("capture_key", "Option+Space"), "screenshot_key": h.Store.GetPref("screenshot_key", "Option+Shift+4")}, nil
	})
	route("POST /local/session/login", h.login)
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
		h.sessionMu.Lock()
		defer h.sessionMu.Unlock()
		current, err := h.Sessions.Load()
		if err != nil || current.Token != s.Token {
			return nil, problem{409, "登录状态已变化"}
		}
		if err := h.API.RevokeDesktopSession(r.Context(), s); err != nil {
			if ae, ok := api.AsAPIError(err); !ok || ae.Status != 401 {
				return nil, err
			}
		}
		err = h.Sessions.Clear()
		h.Change()
		return nil, err
	})
	accountRoute("POST /local/capture", func(s auth.StoredSession, r *http.Request) (any, error) {
		if !h.Captures.Begin() {
			return nil, problem{503, "Spark 正在退出"}
		}
		defer h.Captures.Done()
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
		if s.Public(time.Now()).Expired {
			return nil, problem{401, "会话已到期，请重新登录"}
		}
		return h.API.SearchCollections(r.Context(), s, r.URL.Query().Get("q"), "", "", "", 30)
	})
	accountRoute("GET /local/collections", func(s auth.StoredSession, r *http.Request) (any, error) {
		return h.Store.ListCachedCollections(s.AccountID, r.URL.Query().Get("project_id"), 100)
	})
	accountRoute("GET /local/collections/page", func(s auth.StoredSession, r *http.Request) (any, error) {
		if s.Public(time.Now()).Expired {
			return nil, problem{401, "会话已到期，请重新登录"}
		}
		q := r.URL.Query()
		return h.Engine.CollectionPage(r.Context(), s, q.Get("project_id"), q.Get("tag_id"), q.Get("cursor"), 40)
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
		if s.Public(time.Now()).Expired || r.URL.Query().Get("local") == "1" {
			return h.cachedDetail(s.AccountID, id)
		}
		c, err := h.remoteDetail(r, s, id)
		if err == nil {
			return response{"collection": c}, nil
		}
		var missing problem
		if errors.As(err, &missing) {
			return nil, err
		}
		if ae, ok := api.AsAPIError(err); ok && ae.Status != 429 && ae.Status != 401 && ae.Status < 500 {
			return nil, err
		}
		return h.cachedDetail(s.AccountID, id)
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
		if s.Public(time.Now()).Expired {
			return nil, problem{401, "请重新登录后读取云端图片"}
		}
		b, mime, err := h.API.GetAttachmentThumbnail(r.Context(), s, id)
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
			col, e := h.remoteDetail(r, s, id)
			if e != nil {
				return nil, e
			}
			if len(col.Attachments) == 0 {
				return nil, problem{404, "没有可复制的图片"}
			}
			data, err = h.API.OriginalImage(r.Context(), s, col.Attachments[0].ID)
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
	accountRoute("GET /local/clipboard", func(_ auth.StoredSession, r *http.Request) (any, error) {
		if !h.PanelVisible() {
			return response{"available": false}, nil
		}
		v, ok := h.Clipboard.FreshSample(time.Now(), native.ReadClipboardSample)
		if !ok {
			return response{"available": false}, nil
		}
		return response{"available": true, "change_count": v.ChangeCount, "text": v.Text, "image": v.ImagePNG}, nil
	})
	route("POST /local/clipboard/dismiss", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var input struct {
			Count *int `json:"change_count"`
		}
		if err := decode(r, &input); err != nil {
			return nil, err
		}
		if input.Count == nil {
			return nil, problem{400, "剪贴板建议编号无效"}
		}
		h.Clipboard.DismissSample(*input.Count)
		return nil, nil
	})
	route("POST /local/clipboard/copy", func(_ http.ResponseWriter, r *http.Request) (any, error) {
		var v struct{ Text string }
		if err := decode(r, &v); err != nil {
			return nil, err
		}
		if !h.CopyText(v.Text) {
			return nil, problem{503, "未能写入系统剪贴板，请重试。"}
		}
		return nil, nil
	})
	return m
}

func (h *Host) cachedDetail(account, id string) (any, error) {
	c, ok, err := h.Store.GetCachedCollectionDetail(account, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, problem{404, "本机尚未缓存这条收藏的详情"}
	}
	return response{"collection": c, "offline": true}, nil
}

func (h *Host) remoteDetail(r *http.Request, s auth.StoredSession, id string) (api.Collection, error) {
	read := h.Store.BeginCollectionRead(s.AccountID)
	defer read.Close()
	c, err := h.API.GetCollection(r.Context(), s, id)
	if err == nil && c.ID != id {
		return api.Collection{}, problem{502, "收藏回执编号不符"}
	}
	ae, apiErr := api.AsAPIError(err)
	if (apiErr && ae.Status == 404) || (err == nil && c.DeletedAt != nil) {
		changed, e := read.Delete(id)
		if e != nil {
			return api.Collection{}, problem{500, "无法清除已删除收藏的缓存"}
		}
		if changed {
			h.Change()
		}
		return api.Collection{}, problem{404, "这条收藏已删除或不存在"}
	}
	if err != nil {
		return api.Collection{}, err
	}
	accepted, err := read.ApplyDetail(c)
	if err != nil {
		return api.Collection{}, problem{500, "无法更新本机收藏缓存"}
	}
	if !accepted {
		return api.Collection{}, problem{404, "收藏状态已更新，请重新打开。"}
	}
	return c, nil
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

// login accepts credentials only from the bundled UI. Never relay raw upstream errors to it.
func (h *Host) login(w http.ResponseWriter, r *http.Request) (any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var input api.LoginRequest
	if err := decode(r, &input); err != nil {
		return nil, problem{422, "请输入有效的邮箱和密码。"}
	}
	input.Email = strings.TrimSpace(input.Email)
	if input.Email == "" || input.Password == "" || utf8.RuneCountInString(input.Password) > 128 {
		return nil, problem{422, "请输入有效的邮箱和密码。"}
	}
	h.sessionMu.Lock()
	defer h.sessionMu.Unlock()
	current, _ := h.Sessions.Load()
	if current.Public(time.Now()).Connected || r.Header.Get("X-Spark-Account") != current.AccountID {
		return nil, problem{409, "账号状态已变化，请重新打开随手记。"}
	}
	v, err := h.API.Login(r.Context(), input)
	if err != nil {
		return nil, loginProblem(err)
	}
	if !auth.IsValidSecret(v.Token) || uuid.Validate(v.AccountID) != nil || !v.ExpiresAt.After(time.Now()) {
		return nil, problem{502, "服务端没有返回有效的桌面会话。"}
	}
	issued := auth.StoredSession{Origin: h.API.BaseURL(), Token: v.Token, AccountID: v.AccountID, AccountLabel: v.AccountLabel, ExpiresAt: v.ExpiresAt}
	if err := h.Sessions.Save(issued); err != nil {
		_ = h.API.RevokeDesktopSession(r.Context(), issued)
		return nil, problem{500, "无法保存到系统钥匙串，请解锁钥匙串后重试。"}
	}
	h.Clipboard.Observe(native.ClipboardCount(), time.Now())
	h.Clipboard.Dismiss()
	h.Engine.RequestCatalog()
	h.Engine.Trigger()
	h.Change()
	return nil, nil
}

func loginProblem(err error) error {
	ae, ok := api.AsAPIError(err)
	if !ok {
		return problem{503, "无法连接 Spark，请检查网络后重试。"}
	}
	switch ae.Status {
	case 401:
		if ae.Code == "session_expired" || ae.Code == "desktop_session_expired" {
			return problem{503, "当前服务端尚未开放桌面登录，请在服务更新后重试。"}
		}
		return problem{401, "邮箱或密码不正确。"}
	case 422:
		return problem{422, "请检查邮箱和密码的格式。"}
	case 404, 405, 501:
		return problem{503, "当前服务端尚未开放桌面登录，请在服务更新后重试。"}
	case 429:
		if ae.RetryAfter > 0 {
			return problem{429, fmt.Sprintf("登录请求过于频繁，请在 %d 秒后重试。", int(ae.RetryAfter.Seconds()))}
		}
		return problem{429, "登录请求过于频繁，请稍后重试。"}
	default:
		return problem{502, "Spark 暂时无法完成登录，请稍后重试。"}
	}
}
