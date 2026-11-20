package backend

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const smtpAttemptTimeout = 12 * time.Second

type SMTPDelivery struct {
	host, port, mode, from string
	username, password     string
	tls                    *tls.Config
}

func LoadSMTPDelivery() (*SMTPDelivery, error) {
	cfg := &SMTPDelivery{
		host: os.Getenv("SPARK_SMTP_HOST"), port: os.Getenv("SPARK_SMTP_PORT"),
		mode: os.Getenv("SPARK_SMTP_TLS"), from: os.Getenv("SPARK_SMTP_FROM"),
	}
	if cfg.mode == "" {
		cfg.mode = "implicit"
	}
	if cfg.mode != "implicit" && cfg.mode != "starttls" {
		return nil, errors.New("SPARK_SMTP_TLS must be implicit or starttls")
	}
	if cfg.port == "" {
		cfg.port = "465"
		if cfg.mode == "starttls" {
			cfg.port = "587"
		}
	}
	n, err := strconv.Atoi(cfg.port)
	if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != cfg.port {
		return nil, errors.New("invalid SPARK_SMTP_PORT")
	}
	if cfg.host == "" || (net.ParseIP(cfg.host) == nil && strings.IndexFunc(cfg.host, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-')
	}) >= 0) {
		return nil, errors.New("SPARK_SMTP_HOST must be the certificate host name or IP")
	}
	if !smtpAddress(cfg.from) || internationalSMTPAddress(cfg.from) {
		return nil, errors.New("SPARK_SMTP_FROM must be a bare ASCII email address")
	}
	cfg.tls = &tls.Config{ServerName: cfg.host, MinVersion: tls.VersionTLS12}
	if path := os.Getenv("SPARK_SMTP_CA_FILE"); path != "" {
		pem, err := readSMTPFile(path, 1<<20)
		if err != nil {
			return nil, errors.New("cannot read SMTP trust CA")
		}
		roots, err := x509.SystemCertPool()
		if err != nil || !roots.AppendCertsFromPEM(pem) {
			return nil, errors.New("invalid SMTP trust CA")
		}
		cfg.tls.RootCAs = roots
	}
	data, err := readSMTPFile(os.Getenv("SPARK_SMTP_CREDENTIALS_FILE"), 8<<10)
	if err != nil {
		return nil, errors.New("cannot read SMTP credentials file")
	}
	defer clear(data)
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credentials) != nil || decoder.Decode(new(any)) != io.EOF ||
		credentials.Username == "" || credentials.Password == "" ||
		strings.ContainsAny(credentials.Username+credentials.Password, "\x00\r\n") {
		return nil, errors.New("invalid SMTP credentials file")
	}
	cfg.username, cfg.password = credentials.Username, credentials.Password
	return cfg, nil
}

func readSMTPFile(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, errors.New("invalid SMTP configuration file")
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(data)) > max {
		return nil, errors.New("invalid SMTP file size")
	}
	return data, nil
}

func smtpAddress(value string) bool {
	addr, err := mail.ParseAddress(value)
	if err != nil || addr.Address != value || len(value) > 254 || !strings.Contains(value, "@") {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) }) < 0
}

func internationalSMTPAddress(value string) bool {
	return strings.IndexFunc(value, func(r rune) bool { return r >= unicode.MaxASCII+1 }) >= 0
}

type mailDeliveryResult struct {
	state, reason string
}

func smtpFailure(err error, reason string) mailDeliveryResult {
	var reply *textproto.Error
	if errors.As(err, &reply) && (reply.Code < 400 || reply.Code >= 500) {
		return mailDeliveryResult{"failed", reason}
	}
	return mailDeliveryResult{"retry", reason}
}

// SMTP has no general submission idempotency key. Only a definite rejection
// or a failure before DATA can be retried; losing the final reply is uncertain.
func (s *SMTPDelivery) send(ctx context.Context, to string, data []byte, stillValid func(context.Context) (bool, error)) mailDeliveryResult {
	ctx, cancel := context.WithTimeout(ctx, smtpAttemptTimeout)
	defer cancel()
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(s.host, s.port))
	if err != nil {
		return smtpFailure(err, "smtp_connect_failed")
	}
	defer raw.Close()
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	deadline, _ := ctx.Deadline()
	if err := raw.SetDeadline(deadline); err != nil {
		return smtpFailure(err, "smtp_connect_failed")
	}

	var conn net.Conn = raw
	if s.mode == "implicit" {
		verified := tls.Client(raw, s.tls.Clone())
		if err := verified.HandshakeContext(ctx); err != nil {
			return mailDeliveryResult{"failed", "smtp_tls_failed"}
		}
		conn = verified
	}
	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		return smtpFailure(err, "smtp_greeting_failed")
	}
	defer client.Close()
	if s.mode == "starttls" {
		if err := client.Hello("localhost"); err != nil {
			return smtpFailure(err, "smtp_greeting_failed")
		}
		if tlsSupported, _ := client.Extension("STARTTLS"); !tlsSupported {
			return mailDeliveryResult{"failed", "smtp_starttls_required"}
		}
		if err := client.StartTLS(s.tls.Clone()); err != nil {
			return mailDeliveryResult{"failed", "smtp_tls_failed"}
		}
	}
	if state, ok := client.TLSConnectionState(); !ok || len(state.VerifiedChains) == 0 {
		return mailDeliveryResult{"failed", "smtp_tls_failed"}
	}
	if internationalSMTPAddress(to) {
		if supported, _ := client.Extension("SMTPUTF8"); !supported {
			return mailDeliveryResult{"failed", "smtp_utf8_unavailable"}
		}
	}
	if err := client.Auth(smtp.PlainAuth("", s.username, s.password, s.host)); err != nil {
		return smtpFailure(err, "smtp_auth_failed")
	}
	if err := client.Mail(s.from); err != nil {
		return smtpFailure(err, "smtp_sender_rejected")
	}
	if err := client.Rcpt(to); err != nil {
		return smtpFailure(err, "smtp_recipient_rejected")
	}
	valid, err := stillValid(ctx)
	if err != nil {
		return mailDeliveryResult{"retry", "mail_eligibility_unavailable"}
	}
	if !valid {
		return mailDeliveryResult{"cancelled", "challenge_inactive"}
	}
	message, err := client.Data()
	if err != nil {
		return smtpFailure(err, "smtp_data_rejected")
	}
	if _, err := message.Write(data); err != nil {
		// The terminating dot has not been written.
		return smtpFailure(err, "smtp_write_failed")
	}
	if err := message.Close(); err != nil {
		var reply *textproto.Error
		if errors.As(err, &reply) && reply.Code >= 400 && reply.Code < 600 {
			return smtpFailure(err, "smtp_message_rejected")
		}
		return mailDeliveryResult{"uncertain", "smtp_acceptance_unknown"}
	}
	return mailDeliveryResult{"accepted", ""}
}
