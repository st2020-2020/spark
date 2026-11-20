package backend

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"net"
	"net/mail"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type smtpFixture struct {
	mode     string
	answers  []string
	auth     atomic.Int32
	attempts atomic.Int32
	messages chan smtpFixtureMessage
}

type smtpFixtureMessage struct {
	recipient string
	wire      []byte
}

func newSMTPFixture(t *testing.T, mode, advertisedMode string, answers ...string) (*smtpFixture, *SMTPDelivery) {
	t.Helper()
	fixture := &smtpFixture{mode: advertisedMode, answers: answers, messages: make(chan smtpFixtureMessage, 16)}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsServer, ca := syntheticSMTPcertificate(t)
	var wg sync.WaitGroup
	wg.Go(func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Go(func() { fixture.handle(conn, tlsServer) })
		}
	})
	t.Cleanup(func() {
		_ = ln.Close()
		wg.Wait()
	})
	dir := t.TempDir()
	trust := filepath.Join(dir, "ca.pem")
	credentials := filepath.Join(dir, "credentials.json")
	if err := os.WriteFile(trust, ca, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentials, []byte(`{"username":"fixture-user","password":"fixture-password"}`), 0600); err != nil {
		t.Fatal(err)
	}
	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_SMTP_HOST", host)
	t.Setenv("SPARK_SMTP_PORT", port)
	t.Setenv("SPARK_SMTP_TLS", mode)
	t.Setenv("SPARK_SMTP_FROM", "spark@mail.example.test")
	t.Setenv("SPARK_SMTP_CA_FILE", trust)
	t.Setenv("SPARK_SMTP_CREDENTIALS_FILE", credentials)
	sender, err := LoadSMTPDelivery()
	if err != nil {
		t.Fatal(err)
	}
	return fixture, sender
}

func syntheticSMTPcertificate(t *testing.T) (*tls.Config, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{
		SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, BasicConstraintsValid: true, IsCA: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}},
	}
	return cfg, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func (s *smtpFixture) handle(raw net.Conn, tlsServer *tls.Config) {
	defer raw.Close()
	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	secure := s.mode == "implicit"
	var conn net.Conn = raw
	if secure {
		conn = tls.Server(raw, tlsServer)
	}
	reply := func(value string) bool {
		_, err := io.WriteString(conn, value+"\r\n")
		return err == nil
	}
	commands := textproto.NewReader(bufio.NewReader(conn))
	if !reply("220 controlled SMTP ready") {
		return
	}
	var recipient string
	for {
		line, err := commands.ReadLine()
		if err != nil {
			return
		}
		verb, args, _ := strings.Cut(line, " ")
		switch verb {
		case "EHLO":
			switch {
			case secure:
				if !reply("250-controlled\r\n250 AUTH PLAIN") {
					return
				}
			case s.mode == "starttls":
				if !reply("250-controlled\r\n250 STARTTLS") {
					return
				}
			default:
				if !reply("250-controlled\r\n250 AUTH PLAIN") {
					return
				}
			}
		case "STARTTLS":
			if secure || !reply("220 ready for TLS") {
				return
			}
			secure, conn = true, tls.Server(raw, tlsServer)
			commands = textproto.NewReader(bufio.NewReader(conn))
		case "AUTH":
			s.auth.Add(1)
			expected := "PLAIN " + base64.StdEncoding.EncodeToString([]byte("\x00fixture-user\x00fixture-password"))
			if !secure || args != expected {
				reply("535 authentication rejected")
				return
			}
			if !reply("235 authenticated") {
				return
			}
		case "MAIL":
			if !reply("250 sender accepted") {
				return
			}
		case "RCPT":
			recipient = args
			if !reply("250 recipient accepted") {
				return
			}
		case "DATA":
			if !secure || !reply("354 Send data") {
				return
			}
			wire, err := commands.ReadDotBytes()
			if err != nil {
				return
			}
			n := int(s.attempts.Add(1))
			s.messages <- smtpFixtureMessage{recipient, wire}
			answer := "250 queued"
			if n <= len(s.answers) {
				answer = s.answers[n-1]
			}
			if answer == "" || !reply(answer) {
				return
			}
		default:
			reply("500 unsupported fixture command")
			return
		}
	}
}

func smtpFixtureCode(t *testing.T, m smtpFixtureMessage, email, subject string) string {
	t.Helper()
	if m.recipient != "TO:<"+email+">" {
		t.Fatal("SMTP envelope recipient did not match the test account")
	}
	msg, err := mail.ReadMessage(bytes.NewReader(m.wire))
	if err != nil {
		t.Fatal(err)
	}
	title, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil || title != subject {
		t.Fatalf("unexpected verification subject: %v", err)
	}
	typ, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || typ != "multipart/alternative" {
		t.Fatal("verification mail does not have text and HTML alternatives")
	}
	parts := multipart.NewReader(msg.Body, params["boundary"])
	var code string
	for _, expected := range []string{"text/plain", "text/html"} {
		p, err := parts.NextPart()
		if err != nil || !strings.HasPrefix(p.Header.Get("Content-Type"), expected) {
			t.Fatalf("expected %s alternative: %v", expected, err)
		}
		data, err := io.ReadAll(p)
		if err != nil {
			t.Fatal(err)
		}
		_, after, found := strings.Cut(string(data), "验证码为 ")
		after = strings.TrimPrefix(after, "<strong>")
		if !found || len(after) < 6 {
			t.Fatal("verification code missing from template")
		}
		if code == "" {
			code = after[:6]
		} else if after[:6] != code {
			t.Fatal("mail alternatives contained different verification codes")
		}
	}
	return code
}

func (s *smtpFixture) next(t *testing.T) smtpFixtureMessage {
	t.Helper()
	select {
	case message := <-s.messages:
		return message
	case <-time.After(8 * time.Second):
		t.Fatal("test SMTP server did not receive a message")
		return smtpFixtureMessage{}
	}
}
