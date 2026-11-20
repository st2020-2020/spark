package backend

import (
	"bytes"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/textproto"
	"strings"
	"time"
)

const (
	registerMailSubject = "Spark 注册验证码"
	resetMailSubject    = "Spark 密码重置验证码"
)

func validVerificationCode(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, digit := range code {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func renderChallengeMail(from string, message challengeMail) ([]byte, error) {
	if !smtpAddress(from) || !smtpAddress(message.Email) || !validVerificationCode(message.Code) {
		return nil, errors.New("invalid verification mail")
	}
	var subject, instruction string
	switch message.Purpose {
	case "register":
		subject = registerMailSubject
		instruction = "请在 Spark 受邀注册页输入验证码和邀请码。"
	case "password_reset":
		subject = resetMailSubject
		instruction = "请在 Spark 找回密码页面输入验证码。"
	default:
		return nil, errors.New("unknown verification mail purpose")
	}
	var body bytes.Buffer
	parts := multipart.NewWriter(&body)
	domain := from[strings.LastIndexByte(from, '@')+1:]
	_, _ = fmt.Fprintf(&body, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@%s>\r\nMIME-Version: 1.0\r\nContent-Type: %s\r\n\r\n",
		from, message.Email, mime.QEncoding.Encode("utf-8", subject), time.Now().UTC().Format(time.RFC1123Z),
		message.ChallengeID, domain, mime.FormatMediaType("multipart/alternative", map[string]string{"boundary": parts.Boundary()}))
	for _, content := range []struct{ mime, text string }{
		{"text/plain", instruction + "\r\n\r\n验证码为 " + message.Code + "。验证码自申请起 10 分钟内有效。\r\n如果这封邮件并非由你触发，请忽略。"},
		{"text/html", "<html lang=\"zh-CN\"><body><p>" + instruction + "</p><p>验证码为 <strong>" + message.Code + "</strong>。验证码自申请起 10 分钟内有效。</p><p>如果这封邮件并非由你触发，请忽略。</p></body></html>"},
	} {
		w, err := parts.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {content.mime + "; charset=utf-8"},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, err
		}
		encoded := quotedprintable.NewWriter(w)
		if _, err := encoded.Write([]byte(content.text)); err != nil {
			return nil, err
		}
		if err := encoded.Close(); err != nil {
			return nil, err
		}
	}
	if err := parts.Close(); err != nil {
		return nil, err
	}
	return body.Bytes(), nil
}
