package asset

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const credentialsPath = "/run/secrets/spark-oss-credentials.json"

// OSSConfig is the shared oss-v2 configuration file format.
type OSSConfig struct {
	Version         string `json:"version"`
	OSSRegion       string `json:"oss_region"`
	OSSEndpoint     string `json:"oss_endpoint"`
	OSSUseCNAME     bool   `json:"oss_use_cname"`
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix"`
	CredentialsFile string `json:"credentials_file"`
	PutTTL          int    `json:"put_ttl_seconds"`
	GetTTL          int    `json:"get_ttl_seconds"`
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

// Load returns nil when OSS is disabled. The base API can start without
// reading any integration file.
func Load(env string) (*OSS, error) {
	if os.Getenv("SPARK_OSS_ENABLED") != "true" {
		return nil, nil
	}
	path := os.Getenv("SPARK_OSS_CONFIG_FILE")
	if path == "" {
		path = "/run/spark-oss/config.json"
	}
	var c OSSConfig
	if err := readJSON(path, &c); err != nil {
		return nil, errors.New("cannot read OSS configuration")
	}
	if c.CredentialsFile == "" {
		c.CredentialsFile = credentialsPath
	}
	if c.Version != "oss-v2" || !regionPattern.MatchString(c.OSSRegion) ||
		!bucketPattern.MatchString(c.Bucket) || !prefixPattern.MatchString(c.Prefix) || len(c.Prefix) > 512 ||
		!filepath.IsAbs(c.CredentialsFile) ||
		c.PutTTL < 1 || c.PutTTL > 600 || c.GetTTL < 1 || c.GetTTL > 300 {
		return nil, errors.New("invalid OSS configuration")
	}
	if env == "production" && c.CredentialsFile != credentialsPath {
		return nil, errors.New("production OSS credentials require the dedicated secret mount")
	}
	if _, err := endpoint(c.OSSEndpoint, env); err != nil {
		return nil, errors.New("invalid OSS endpoint")
	}
	var key accessKey
	if err := readJSON(c.CredentialsFile, &key); err != nil || strings.TrimSpace(key.ID) == "" || strings.TrimSpace(key.Secret) == "" {
		return nil, errors.New("cannot read OSS credentials")
	}
	return newOSS(c, key), nil
}

func endpoint(raw, env string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("endpoint must be an origin")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	local := host == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(env == "development" && u.Scheme == "http" && local) {
		return nil, errors.New("endpoint requires HTTPS")
	}
	return u, nil
}

func readJSON(path string, dest any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	const maxConfigBytes = 16 << 10
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxConfigBytes {
		return errors.New("invalid config file")
	}
	d := json.NewDecoder(io.LimitReader(f, maxConfigBytes+1))
	// The protected platform key file may also carry metadata for other services.
	if _, credentials := dest.(*accessKey); !credentials {
		d.DisallowUnknownFields()
	}
	if err := d.Decode(dest); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected content after configuration")
	}
	return nil
}
