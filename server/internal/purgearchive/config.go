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
	"spark/server/internal/asset"
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
	location, err := loadOSSLocation(configFile, os.Getenv("SPARK_DELETION_LEDGER_OSS_PREFIX"))
	if err != nil {
		return nil, err
	}
	local, err := location.validate(env)
	if err != nil {
		return nil, err
	}
	secretFile := os.Getenv("SPARK_DELETION_LEDGER_OSS_CREDENTIALS_FILE")
	if secretFile == "" {
		secretFile = ossCredentialsPath
	}
	key, err := loadAccessKey(secretFile)
	if err != nil {
		return nil, err
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

func loadOSSLocation(name, ledgerPrefix string) (OSSLocation, error) {
	var location OSSLocation
	invalid := errors.New("invalid deletion ledger OSS configuration")
	data, err := readConfigFile(name)
	if err != nil {
		return location, invalid
	}
	fields, err := exactObject(data)
	if err != nil {
		return location, invalid
	}
	if _, shared := fields["version"]; shared {
		if ledgerPrefix == "" {
			return location, errors.New("SPARK_DELETION_LEDGER_OSS_PREFIX is required with an oss-v2 attachment configuration")
		}
		if _, err := exactObject(data, "version", "oss_region", "oss_endpoint", "oss_use_cname",
			"bucket", "prefix", "credentials_file", "put_ttl_seconds", "get_ttl_seconds"); err != nil {
			return location, invalid
		}
		var config asset.OSSConfig
		if err := decodeJSON(data, &config); err != nil || config.Version != "oss-v2" || config.Prefix == "" || config.OSSUseCNAME {
			return location, invalid
		}
		// The attachment configuration's credential path and signed URL
		// settings do not grant authority to the archive.
		return OSSLocation{
			Region: config.OSSRegion, Endpoint: config.OSSEndpoint, Bucket: config.Bucket,
			Prefix: ledgerPrefix, ObjectPrefix: config.Prefix,
		}, nil
	}
	fields, err = exactObject(data, "region", "endpoint", "bucket", "prefix", "object_prefix")
	if err != nil || len(fields) != 5 || decodeJSON(data, &location) != nil {
		return OSSLocation{}, invalid
	}
	if ledgerPrefix != "" && ledgerPrefix != location.Prefix {
		return OSSLocation{}, errors.New("SPARK_DELETION_LEDGER_OSS_PREFIX conflicts with the configured deletion ledger prefix")
	}
	return location, nil
}

func loadAccessKey(name string) (accessKey, error) {
	var key accessKey
	invalid := errors.New("invalid deletion ledger OSS credentials")
	data, err := readConfigFile(name)
	if err != nil {
		return key, invalid
	}
	fields, err := exactObject(data)
	if err != nil || decodeJSON(fields["access_key_id"], &key.ID) != nil ||
		decodeJSON(fields["access_key_secret"], &key.Secret) != nil ||
		strings.TrimSpace(key.ID) == "" || strings.TrimSpace(key.Secret) == "" {
		return accessKey{}, invalid
	}
	return key, nil
}

func readConfigFile(name string) ([]byte, error) {
	if !filepath.IsAbs(name) {
		return nil, errors.New("configuration file path must be absolute")
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxConfigBytes {
		return nil, errors.New("invalid configuration file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil || len(data) > maxConfigBytes {
		return nil, errors.New("invalid configuration file")
	}
	return data, nil
}
