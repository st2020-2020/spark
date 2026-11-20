package backend

import (
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	Env, Addr, Origin, DatabaseURL, MailMode string
	Secret, EncryptionKey                    []byte
	Container                                bool
	AIEnabled                                bool
	ImageAnalysisEnabled                     bool
	URLExtractEnabled                        bool
	PurgeEnabled                             bool
	AITrial                                  AITrialScope
}

func LoadConfig() (Config, error) {
	c := Config{AIEnabled: os.Getenv("SPARK_AI_ENABLED") == "true", Container: os.Getenv("SPARK_CONTAINER") == "true", Env: os.Getenv("SPARK_ENV"), Addr: os.Getenv("SPARK_ADDR"), Origin: os.Getenv("SPARK_ORIGIN"), DatabaseURL: os.Getenv("DATABASE_URL"), MailMode: os.Getenv("SPARK_MAIL_MODE")}
	c.ImageAnalysisEnabled = os.Getenv("SPARK_IMAGE_ANALYSIS_ENABLED") == "true"
	c.URLExtractEnabled = os.Getenv("SPARK_URL_EXTRACT_ENABLED") == "true"
	c.PurgeEnabled = os.Getenv("SPARK_PURGE_ENABLED") == "true"
	if c.Env == "" {
		c.Env = "production"
	}
	if c.Addr == "" {
		c.Addr = "127.0.0.1:8080"
	}
	if c.MailMode == "" {
		c.MailMode = "disabled"
	}
	var err error
	c.AITrial, err = ParseAITrialScope(c.Env, os.Getenv("SPARK_AI_TRIAL_USER_IDS"))
	if err != nil {
		return c, err
	}
	c.Secret, err = base64.StdEncoding.DecodeString(os.Getenv("SPARK_SECRET"))
	if err != nil || len(c.Secret) != 32 {
		return c, errors.New("SPARK_SECRET must be base64 encoded 32 random bytes")
	}
	c.EncryptionKey, err = base64.StdEncoding.DecodeString(os.Getenv("SPARK_ENCRYPTION_KEY"))
	if err != nil || len(c.EncryptionKey) != 32 {
		return c, errors.New("SPARK_ENCRYPTION_KEY must be base64 encoded 32 random bytes")
	}
	if string(c.Secret) == string(c.EncryptionKey) {
		return c, errors.New("secrets must be distinct")
	}
	if c.Env != "development" && c.Env != "production" {
		return c, errors.New("SPARK_ENV must be development or production")
	}
	u, e := url.Parse(c.Origin)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return c, errors.New("SPARK_ORIGIN must be an exact origin")
	}
	if c.Env == "production" && u.Scheme != "https" {
		return c, errors.New("production origin requires HTTPS")
	}
	if c.Env == "development" {
		host, _, e := net.SplitHostPort(c.Addr)
		if e != nil || !(isLoopback(host) || c.Container && host == "0.0.0.0") || u.Scheme != "http" || !isLoopback(u.Hostname()) {
			return c, errors.New("development mode requires loopback HTTP origin; wildcard listen requires SPARK_CONTAINER=true")
		}
	}
	if c.MailMode != "disabled" && c.MailMode != "development" && !isMailDeliveryMode(c.MailMode) {
		return c, errors.New("SPARK_MAIL_MODE must be disabled, development, smtp, or tencent-ses")
	}
	if c.MailMode == "development" && c.Env != "development" {
		return c, errors.New("development mailbox is forbidden in production")
	}
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	return c, nil
}
func isLoopback(s string) bool {
	ip := net.ParseIP(s)
	return s == "localhost" || ip != nil && ip.IsLoopback()
}
