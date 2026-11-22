package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// DefaultAPIBaseURL can be overridden at build time via:
// -ldflags "-X spark/apps/desktop/internal/config.DefaultAPIBaseURL=https://spark.example.com"
var DefaultAPIBaseURL = "https://spark.stwqy.cloud"

const (
	AppBundleID     = "com.spark.desktop"
	KeychainService = "com.spark.desktop.session"
	DataDirEnv      = "SPARK_DESKTOP_DATA_DIR"
	APIBaseURLEnv   = "SPARK_DESKTOP_API_URL"
)

// Config holds runtime settings for the desktop host process.
// The API origin is strictly validated as HTTPS in normal usage.
// AllowLoopbackHTTP is reserved for isolated local/QA testing.
type Config struct {
	APIBaseURL        string
	DataDir           string
	AllowLoopbackHTTP bool
}

// Load resolves runtime configuration without reading or touching the legacy ./data directory.
func Load() (Config, error) {
	rawURL := DefaultAPIBaseURL
	allowLoopback := os.Getenv("SPARK_DESKTOP_ALLOW_LOOPBACK_HTTP") == "1"
	if allowLoopback && os.Getenv(APIBaseURLEnv) == "" {
		return Config{}, errors.New("请指定隔离测试的回环 API 地址")
	}
	if u := os.Getenv(APIBaseURLEnv); u != "" {
		if !allowLoopback || !strings.HasPrefix(u, "http://") || os.Getenv(DataDirEnv) == "" {
			return Config{}, errors.New("测试服务需要显式的回环 HTTP 地址及独立数据目录")
		}
		rawURL = u
	}
	normalized, err := ValidateAPIBaseURL(rawURL, allowLoopback)
	if err != nil {
		return Config{}, err
	}

	dataDir, err := ResolveDataDir()
	if err != nil {
		return Config{}, err
	}

	return Config{
		APIBaseURL:        normalized,
		DataDir:           dataDir,
		AllowLoopbackHTTP: allowLoopback,
	}, nil
}

// ResolveDataDir determines where the new macOS desktop client stores its own SQLite cache
// and pending attachment files. It intentionally NEVER uses ./data or the legacy MyGo Spark folder.
func ResolveDataDir() (string, error) {
	if custom := strings.TrimSpace(os.Getenv(DataDirEnv)); custom != "" {
		return filepath.Abs(custom)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config dir: %w", err)
	}
	return filepath.Join(base, "SparkDesktop"), nil
}

// ValidateAPIBaseURL ensures the configured Spark origin uses HTTPS (with no credentials or query),
// or loopback HTTP only when explicitly permitted for isolated testing.
func ValidateAPIBaseURL(raw string, allowLoopbackHTTP bool) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("API base URL is empty")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse API base URL: %w", err)
	}
	if u.User != nil {
		return "", errors.New("API base URL must not contain credentials")
	}
	if u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("API base URL must not contain query or fragment")
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("API base URL missing host")
	}
	switch scheme {
	case "https":
		return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), nil
	case "http":
		if allowLoopbackHTTP && (host == "127.0.0.1" || host == "localhost" || host == "::1") {
			return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), nil
		}
		return "", errors.New("API base URL must use HTTPS")
	default:
		return "", fmt.Errorf("unsupported API scheme %q", u.Scheme)
	}
}
