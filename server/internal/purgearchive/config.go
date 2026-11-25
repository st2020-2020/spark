package purgearchive

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

const (
	ossConfigPath      = "/run/spark-deletion-ledger/oss.json"
	ossCredentialsPath = "/run/secrets/spark-deletion-ledger-oss"
	maxConfigBytes     = 16 << 10
)

// OSSLocation is safe to report in operator commands.
type OSSLocation struct {
	Region       string `json:"region"`
	Endpoint     string `json:"endpoint"`
	Bucket       string `json:"bucket"`
	Prefix       string `json:"prefix"`
	ObjectPrefix string `json:"object_prefix"`
}

type accessKey struct {
	ID     string `json:"access_key_id"`
	Secret string `json:"access_key_secret"`
}

var (
	regionPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)+$`)
	bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	prefixPattern = regexp.MustCompile(`^(?:[a-zA-Z0-9_-]+/)+$`)
)

func OpenConfigured(ctx context.Context) (Archive, error) {
	switch os.Getenv("SPARK_DELETION_LEDGER_BACKEND") {
	case "", "file":
		return Open(os.Getenv("SPARK_DELETION_LEDGER_DIR"))
	case "oss":
		return openOSS(ctx)
	default:
		return nil, errors.New("SPARK_DELETION_LEDGER_BACKEND must be file or oss")
	}
}

func openOSS(ctx context.Context) (*OSS, error) {
	env := os.Getenv("SPARK_ENV")
	switch env {
	case "":
		env = "production"
	case "production", "development":
	default:
		return nil, errors.New("SPARK_ENV must be development or production")
	}
	configFile := os.Getenv("SPARK_DELETION_LEDGER_OSS_CONFIG_FILE")
	if configFile == "" {
		configFile = ossConfigPath
	}
	var location OSSLocation
	if err := loadJSONFile(configFile, &location, "region", "endpoint", "bucket", "prefix", "object_prefix"); err != nil {
		return nil, errors.New("invalid deletion ledger OSS configuration")
	}
	local, err := location.validate(env)
	if err != nil {
		return nil, err
	}
	secretFile := os.Getenv("SPARK_DELETION_LEDGER_OSS_CREDENTIALS_FILE")
	if secretFile == "" {
		secretFile = ossCredentialsPath
	}
	var key accessKey
	if err := loadJSONFile(secretFile, &key, "access_key_id", "access_key_secret"); err != nil ||
		strings.TrimSpace(key.ID) == "" || strings.TrimSpace(key.Secret) == "" {
		return nil, errors.New("invalid deletion ledger OSS credentials")
	}
	archive := newOSS(location, key, local)
	if err := archive.Check(ctx); err != nil {
		archive.Close()
		return nil, err
	}
	return archive, nil
}

func (l OSSLocation) validate(env string) (local bool, err error) {
	if !regionPattern.MatchString(l.Region) || !bucketPattern.MatchString(l.Bucket) ||
		!validPrefix(l.Prefix) || l.ObjectPrefix != "" && (!validPrefix(l.ObjectPrefix) ||
		strings.HasPrefix(l.Prefix, l.ObjectPrefix) || strings.HasPrefix(l.ObjectPrefix, l.Prefix)) {
		return false, errors.New("invalid or overlapping deletion ledger OSS prefix, region or bucket")
	}
	u, err := url.Parse(l.Endpoint)
	if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		u.Host == "" || l.Endpoint != u.Scheme+"://"+u.Host {
		return false, errors.New("invalid deletion ledger OSS endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	if env == "development" && u.Scheme == "http" && (u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()) {
		return true, nil
	}
	public, internal := "oss-"+l.Region+".aliyuncs.com", "oss-"+l.Region+"-internal.aliyuncs.com"
	if u.Scheme != "https" || u.Host != public && u.Host != internal {
		return false, errors.New("deletion ledger OSS endpoint must be the regional Alibaba Cloud HTTPS origin")
	}
	return false, nil
}

func validPrefix(p string) bool { return len(p) <= 512 && prefixPattern.MatchString(p) }

func newOSS(location OSSLocation, key accessKey, usePathStyle bool) *OSS {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	httpClient := &http.Client{
		Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	cfg := oss.LoadDefaultConfig().
		WithCredentialsProvider(credentials.NewStaticCredentialsProvider(key.ID, key.Secret)).
		WithRegion(location.Region).WithEndpoint(location.Endpoint).WithUsePathStyle(usePathStyle).
		WithHttpClient(httpClient).WithRetryMaxAttempts(1).WithLogLevel(oss.LogOff).WithSignatureVersion(oss.SignatureVersionV4)
	return &OSS{location: location, client: oss.NewClient(cfg), httpClient: httpClient}
}

func loadJSONFile(name string, dest any, fields ...string) error {
	if !filepath.IsAbs(name) {
		return errors.New("configuration file path must be absolute")
	}
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxConfigBytes {
		return errors.New("invalid configuration file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return errors.New("invalid configuration file")
	}
	object, err := exactObject(data, fields...)
	if err != nil || len(object) != len(fields) {
		return errors.New("missing or invalid configuration fields")
	}
	return decodeJSON(data, dest)
}
