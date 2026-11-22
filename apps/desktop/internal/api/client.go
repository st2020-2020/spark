package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"spark/apps/desktop/internal/config"
)

const (
	defaultAPITimeout = 15 * time.Second
	defaultOSSTimeout = 60 * time.Second
	maxJSONRespBytes  = 4 * 1024 * 1024
	maxThumbBytes     = 5 * 1024 * 1024
)

// APIError captures structured Spark backend errors.
type APIError struct {
	Status     int
	Code       string
	Message    string
	RequestID  string
	RetryAfter time.Duration
	Details    map[string]any
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s (%d %s)", e.Message, e.Status, e.Code)
	}
	return fmt.Sprintf("HTTP %d %s", e.Status, e.Code)
}

func AsAPIError(err error) (*APIError, bool) {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}

// Client is the Go-host-only HTTP client for the Spark backend and OSS direct upload.
// Security invariants:
//   - No CookieJar (never mixes cookies with desktop Bearer).
//   - Redirects are strictly disabled on both API and OSS clients so Bearer/signed URLs never leak.
//   - OSS PUT uses returned method, raw HTTPS URL, returned headers, explicit ContentLength, and zero Spark auth headers.
type Client struct {
	OnUnauthorized    func(string) error
	baseURL           string
	allowLoopbackHTTP bool
	apiHTTP           *http.Client
	ossHTTP           *http.Client
}

func NewClient(baseURL string, allowLoopbackHTTP bool) (*Client, error) {
	validated, err := config.ValidateAPIBaseURL(baseURL, allowLoopbackHTTP)
	if err != nil {
		return nil, err
	}
	noRedirect := func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Client{
		baseURL:           validated,
		allowLoopbackHTTP: allowLoopbackHTTP,
		apiHTTP: &http.Client{
			Timeout:       defaultAPITimeout,
			CheckRedirect: noRedirect,
		},
		ossHTTP: &http.Client{
			Timeout:       defaultOSSTimeout,
			CheckRedirect: noRedirect,
		},
	}, nil
}

func (c *Client) BaseURL() string { return c.baseURL }

func (c *Client) doJSON(
	ctx context.Context,
	method string,
	path string,
	bearerToken string,
	idempotencyKey string,
	reqBody any,
	respTarget any,
) (int, http.Header, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		switch v := reqBody.(type) {
		case json.RawMessage:
			bodyReader = bytes.NewReader(v)
		case []byte:
			bodyReader = bytes.NewReader(v)
		default:
			raw, err := json.Marshal(reqBody)
			if err != nil {
				return 0, nil, fmt.Errorf("marshal request: %w", err)
			}
			bodyReader = bytes.NewReader(raw)
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+"/api/v1"+path, bodyReader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "SparkDesktop/0.8 (macOS)")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}

	resp, err := c.apiHTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	// Reject redirects explicitly so credentials never follow redirects.
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return resp.StatusCode, resp.Header, &APIError{
			Status:  resp.StatusCode,
			Code:    "unexpected_redirect",
			Message: "服务端返回了未预期的重定向。",
		}
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONRespBytes))
	if err != nil {
		return resp.StatusCode, resp.Header, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode == http.StatusUnauthorized && bearerToken != "" && c.OnUnauthorized != nil {
		if err := c.OnUnauthorized(bearerToken); err != nil {
			return resp.StatusCode, resp.Header, err
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, resp.Header, parseAPIError(resp.StatusCode, resp.Header, raw)
	}
	if respTarget != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, respTarget); err != nil {
			return resp.StatusCode, resp.Header, fmt.Errorf("decode response json: %w", err)
		}
	}
	return resp.StatusCode, resp.Header, nil
}

func parseAPIError(status int, headers http.Header, raw []byte) *APIError {
	ae := &APIError{
		Status:    status,
		RequestID: headers.Get("X-Request-ID"),
	}
	if ra := strings.TrimSpace(headers.Get("Retry-After")); ra != "" {
		if secs, err := strconv.Atoi(ra); err == nil && secs > 0 {
			ae.RetryAfter = time.Duration(secs) * time.Second
		}
	}
	var envelope struct {
		Error struct {
			Code      string         `json:"code"`
			Message   string         `json:"message"`
			RequestID string         `json:"request_id"`
			Details   map[string]any `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &envelope) == nil && (envelope.Error.Code != "" || envelope.Error.Message != "") {
		ae.Code = envelope.Error.Code
		ae.Message = envelope.Error.Message
		if envelope.Error.RequestID != "" {
			ae.RequestID = envelope.Error.RequestID
		}
		ae.Details = envelope.Error.Details
	}
	if ae.Code == "" {
		ae.Code = fmt.Sprintf("http_%d", status)
	}
	return ae
}

// --- Desktop Pairing & Session ---

func (c *Client) Login(ctx context.Context, input LoginRequest) (DesktopTokenResult, error) {
	var out DesktopTokenResult
	status, _, err := c.doJSON(ctx, http.MethodPost, "/desktop/login", "", "", input, &out)
	if status >= 200 && status < 300 && (status != 200 || err != nil || out.Token == "") {
		return DesktopTokenResult{}, &APIError{Status: 502, Code: "invalid_login_response"}
	}
	return out, err
}

func (c *Client) GetDesktopSession(ctx context.Context, token string) (DesktopSession, error) {
	var out DesktopSession
	_, _, err := c.doJSON(ctx, http.MethodGet, "/desktop/session", token, "", nil, &out)
	return out, err
}

func (c *Client) RevokeDesktopSession(ctx context.Context, token string) error {
	_, _, err := c.doJSON(ctx, http.MethodDelete, "/desktop/session", token, "", nil, nil)
	return err
}

// --- Collections (Whitelisted for desktopBearer) ---

// CreateCollectionRaw posts a pre-frozen CollectionCreate JSON payload with its frozen Idempotency-Key.
func (c *Client) CreateCollectionRaw(ctx context.Context, token string, idempotencyKey string, frozenJSON []byte) (Collection, bool, error) {
	var out Collection
	status, headers, err := c.doJSON(ctx, http.MethodPost, "/collections", token, idempotencyKey, json.RawMessage(frozenJSON), &out)
	if err == nil && (status != http.StatusCreated || out.ID == "") {
		return out, false, errors.New("收藏回执不完整")
	}
	replayed := strings.EqualFold(headers.Get("Idempotent-Replayed"), "true")
	return out, replayed, err
}

func (c *Client) ListCollections(ctx context.Context, token string, scope string, projectID string, tagID string, cursor string, limit int) (CollectionPage, error) {
	q := url.Values{}
	if scope != "" {
		q.Set("scope", scope)
	}
	if projectID != "" {
		q.Set("project_id", projectID)
	}
	if tagID != "" {
		q.Set("tag_id", tagID)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/collections"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out CollectionPage
	_, _, err := c.doJSON(ctx, http.MethodGet, path, token, "", nil, &out)
	return out, err
}

func (c *Client) GetCollection(ctx context.Context, token string, id string) (Collection, error) {
	var out Collection
	_, _, err := c.doJSON(ctx, http.MethodGet, "/collections/"+url.PathEscape(id), token, "", nil, &out)
	return out, err
}

// --- Projects & Tags & Search (Whitelisted for desktopBearer) ---

func (c *Client) ListProjects(ctx context.Context, token string, state string, query string, cursor string, limit int) (ProjectPage, error) {
	q := url.Values{}
	if state != "" {
		q.Set("state", state)
	}
	if query != "" {
		q.Set("q", query)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/projects"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out ProjectPage
	_, _, err := c.doJSON(ctx, http.MethodGet, path, token, "", nil, &out)
	return out, err
}

func (c *Client) ListTags(ctx context.Context, token string, query string, cursor string, limit int) (TagPage, error) {
	q := url.Values{}
	if query != "" {
		q.Set("q", query)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/tags"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out TagPage
	_, _, err := c.doJSON(ctx, http.MethodGet, path, token, "", nil, &out)
	return out, err
}

func (c *Client) SearchCollections(ctx context.Context, token string, query string, projectID string, tagID string, cursor string, limit int) (SearchPage, error) {
	q := url.Values{}
	if query != "" {
		q.Set("q", query)
	}
	if projectID != "" {
		q.Set("project_id", projectID)
	}
	if tagID != "" {
		q.Set("tag_id", tagID)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/search"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}
	var out SearchPage
	_, _, err := c.doJSON(ctx, http.MethodGet, path, token, "", nil, &out)
	return out, err
}

// --- Uploads & Attachments (Whitelisted for desktopBearer) ---

func (c *Client) CreateUpload(ctx context.Context, token string, idempotencyKey string, req UploadRequest) (UploadGrant, error) {
	var out UploadGrant
	_, _, err := c.doJSON(ctx, http.MethodPost, "/uploads", token, idempotencyKey, req, &out)
	return out, err
}

func (c *Client) GetUpload(ctx context.Context, token string, uploadID string) (Upload, error) {
	var out Upload
	_, _, err := c.doJSON(ctx, http.MethodGet, "/uploads/"+url.PathEscape(uploadID), token, "", nil, &out)
	return out, err
}

func (c *Client) CompleteUpload(ctx context.Context, token string, uploadID string) (Upload, error) {
	var out Upload
	_, _, err := c.doJSON(ctx, http.MethodPost, "/uploads/"+url.PathEscape(uploadID)+"/complete", token, "", nil, &out)
	return out, err
}

// UploadObjectToOSS uploads raw image bytes directly to the signed OSS URL.
// Enforces:
//   - HTTPS URL (or loopback HTTP only when allowLoopbackHTTP is enabled for isolated tests)
//   - Returned HTTP method and exact signed headers
//   - Explicit req.ContentLength = int64(len(data)) (no chunked transfer encoding)
//   - Redirects disabled; zero Spark Cookie, Bearer, or fake Origin headers.
func (c *Client) UploadObjectToOSS(ctx context.Context, grant UploadGrant, data []byte) error {
	if err := c.validateOSSURL(grant.URL); err != nil {
		return err
	}
	method := strings.ToUpper(strings.TrimSpace(grant.Method))
	if method == "" {
		method = http.MethodPut
	}
	if method != http.MethodPut {
		return fmt.Errorf("unsupported OSS upload method %q", method)
	}

	req, err := http.NewRequestWithContext(ctx, method, grant.URL, bytes.NewReader(data))
	if err != nil {
		return errors.New("图片上传地址格式无效")
	}
	// Explicit ContentLength prevents chunked Transfer-Encoding on OSS PUT.
	req.ContentLength = int64(len(data))
	req.TransferEncoding = nil
	req.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(data)), nil
	}

	for k, v := range grant.Headers {
		lower := strings.ToLower(strings.TrimSpace(k))
		if lower == "cookie" || lower == "origin" || lower == "authorization" || lower == "proxy-authorization" {
			continue
		}
		req.Header.Set(k, v)
	}

	resp, err := c.ossHTTP.Do(req)
	if err != nil {
		return errors.New("无法连接图片存储")
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return &APIError{
			Status:  resp.StatusCode,
			Code:    "oss_redirect_rejected",
			Message: "对象存储返回了未预期的重定向，已拒绝跟随。",
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{
			Status:  resp.StatusCode,
			Code:    "oss_upload_failed",
			Message: fmt.Sprintf("图片上传对象存储失败（HTTP %d）。", resp.StatusCode),
		}
	}
	return nil
}

func (c *Client) validateOSSURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return errors.New("invalid OSS upload URL")
	}
	if u.User != nil {
		return errors.New("OSS upload URL must not contain userinfo")
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if scheme == "https" {
		return nil
	}
	if scheme == "http" && c.allowLoopbackHTTP && (host == "127.0.0.1" || host == "localhost" || host == "::1") {
		return nil
	}
	return errors.New("OSS upload URL must use HTTPS")
}

func (c *Client) GetAttachmentDownload(ctx context.Context, token string, attachmentID string) (DownloadGrant, error) {
	var out DownloadGrant
	_, _, err := c.doJSON(ctx, http.MethodGet, "/attachments/"+url.PathEscape(attachmentID)+"/download", token, "", nil, &out)
	return out, err
}

func (c *Client) GetAttachmentThumbnail(ctx context.Context, token string, attachmentID string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/attachments/"+url.PathEscape(attachmentID)+"/thumbnail", nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "SparkDesktop/0.8 (macOS)")

	resp, err := c.apiHTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return nil, "", &APIError{Status: resp.StatusCode, Code: "unexpected_redirect", Message: "缩略图请求拒绝重定向。"}
	}
	if resp.StatusCode == http.StatusUnauthorized && c.OnUnauthorized != nil {
		if err := c.OnUnauthorized(token); err != nil {
			return nil, "", err
		}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxThumbBytes+1))
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", parseAPIError(resp.StatusCode, resp.Header, raw)
	}
	if len(raw) > maxThumbBytes {
		return nil, "", errors.New("缩略图超过大小限制")
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/jpeg"
	}
	return raw, ct, nil
}

// OriginalImage redeems a short-lived download grant without sending Spark credentials to storage.
func (c *Client) OriginalImage(ctx context.Context, token, id string) ([]byte, error) {
	grant, err := c.GetAttachmentDownload(ctx, token, id)
	if err != nil {
		return nil, err
	}
	if err = c.validateOSSURL(grant.URL); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, grant.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.ossHTTP.Do(req)
	if err != nil {
		return nil, errors.New("无法连接图片存储")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("图片下载失败")
	}
	return io.ReadAll(io.LimitReader(resp.Body, MaxImageBytes+1))
}
