package backend

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
	ses "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/ses/v20201002"
)

const sesEndpoint = "ses.tencentcloudapi.com"

type TencentSESDelivery struct {
	client                          *ses.Client
	from                            string
	registerTemplate, resetTemplate uint64
}

func loadTencentSESDelivery(transport http.RoundTripper) (*TencentSESDelivery, error) {
	region := os.Getenv("SPARK_SES_REGION")
	if region != "ap-guangzhou" && region != "ap-hongkong" {
		return nil, errors.New("SPARK_SES_REGION must be ap-guangzhou or ap-hongkong")
	}
	from := os.Getenv("SPARK_SES_FROM")
	if !smtpAddress(from) || internationalSMTPAddress(from) {
		return nil, errors.New("SPARK_SES_FROM must be a bare ASCII email address")
	}
	registerTemplate, err := sesTemplateID("SPARK_SES_REGISTER_TEMPLATE_ID")
	if err != nil {
		return nil, err
	}
	resetTemplate, err := sesTemplateID("SPARK_SES_RESET_TEMPLATE_ID")
	if err != nil {
		return nil, err
	}

	data, err := readMailConfigFile(os.Getenv("SPARK_SES_CREDENTIALS_FILE"), 8<<10)
	if err != nil {
		return nil, errors.New("cannot read SES credentials file")
	}
	defer clear(data)
	var credentials struct {
		SecretID  string `json:"secret_id"`
		SecretKey string `json:"secret_key"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credentials) != nil || decoder.Decode(new(any)) != io.EOF ||
		credentials.SecretID == "" || credentials.SecretKey == "" ||
		strings.ContainsAny(credentials.SecretID+credentials.SecretKey, "\x00\r\n\t ") {
		return nil, errors.New("invalid SES credentials file")
	}

	cfg := profile.NewClientProfile()
	cfg.HttpProfile.Endpoint = sesEndpoint
	cfg.HttpProfile.Scheme = "HTTPS"
	cfg.HttpProfile.ReqTimeout = 12
	cfg.DisableRegionBreaker = true
	cfg.NetworkFailureMaxRetries = 0
	cfg.RateLimitExceededMaxRetries = 0
	cfg.UnsafeRetryOnConnectionFailure = false
	cfg.Debug = false
	client, err := ses.NewClient(common.NewCredential(credentials.SecretID, credentials.SecretKey), region, cfg)
	if err != nil {
		return nil, errors.New("cannot initialize SES client")
	}
	if transport == nil {
		// A fresh HTTP/1.1 connection avoids transparent transport replays.
		protocols := new(http.Protocols)
		protocols.SetHTTP1(true)
		transport = &http.Transport{
			Protocols:              protocols,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
			DisableKeepAlives:      true,
			DisableCompression:     true,
			MaxResponseHeaderBytes: 32 << 10,
		}
	}
	client.WithHttpTransport(sesTransport{transport})
	client.WithLogger(log.New(io.Discard, "", 0))
	return &TencentSESDelivery{
		client: client, from: from,
		registerTemplate: registerTemplate, resetTemplate: resetTemplate,
	}, nil
}

func sesTemplateID(name string) (uint64, error) {
	n, err := strconv.ParseUint(os.Getenv(name), 10, 64)
	if err != nil || n == 0 {
		return 0, errors.New(name + " must be a positive template ID")
	}
	return n, nil
}

type sesTransport struct {
	next http.RoundTripper
}

func (t sesTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "https" || req.URL.Host != sesEndpoint || req.URL.Path != "/" ||
		req.URL.RawQuery != "" || req.Method != http.MethodPost {
		_ = req.Body.Close()
		return nil, errors.New("invalid SES request endpoint")
	}

	resp, err := t.next.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	// Intercept redirects before the SDK HTTP client can forward a signed POST.
	// Pass only a small JSON envelope to the SDK.
	defer resp.Body.Close()
	contentType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode != http.StatusOK || contentType != "application/json" ||
		resp.Header.Get("Content-Encoding") != "" {
		return nil, errors.New("unexpected SES response")
	}
	const maxResponse = 16 << 10
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		return nil, errors.New("invalid SES response body")
	}
	resp.Body = io.NopCloser(bytes.NewReader(data))
	return resp, nil
}

func (*TencentSESDelivery) adapter() string { return mailModeSES }

func (s *TencentSESDelivery) deliver(ctx context.Context, message challengeMail, stillValid func(context.Context) (bool, error)) mailDeliveryResult {
	if !smtpAddress(message.Email) || !validVerificationCode(message.Code) {
		return mailDeliveryResult{"failed", "mail_payload_invalid"}
	}
	var subject string
	var template uint64
	switch message.Purpose {
	case "register":
		subject, template = registerMailSubject, s.registerTemplate
	case "password_reset":
		subject, template = resetMailSubject, s.resetTemplate
	default:
		return mailDeliveryResult{"failed", "mail_payload_invalid"}
	}
	req := ses.NewSendEmailRequest()
	req.FromEmailAddress = &s.from
	req.Destination = []*string{&message.Email}
	req.Subject = &subject
	req.TriggerType = common.Uint64Ptr(1)
	req.Template = &ses.Template{
		TemplateID: &template,
		// The verified code consists of six ASCII digits.
		TemplateData: common.StringPtr(`{"code":"` + message.Code + `"}`),
	}
	valid, err := stillValid(ctx)
	if err != nil {
		return mailDeliveryResult{"retry", "mail_eligibility_unavailable"}
	}
	if !valid {
		return mailDeliveryResult{"cancelled", "challenge_inactive"}
	}
	resp, err := s.client.SendEmailWithContext(ctx, req)
	if err != nil {
		return sesFailure(err)
	}
	if resp == nil || resp.Response == nil ||
		resp.Response.MessageId == nil || *resp.Response.MessageId == "" ||
		resp.Response.RequestId == nil || *resp.Response.RequestId == "" {
		return mailDeliveryResult{"uncertain", "ses_acceptance_unknown"}
	}
	return mailDeliveryResult{"accepted", ""}
}

func sesFailure(err error) mailDeliveryResult {
	// SDK errors can contain the response body. Persist only fixed reason codes.
	var provider *tcerr.TencentCloudSDKError
	if !errors.As(err, &provider) || provider.GetRequestId() == "" {
		return mailDeliveryResult{"uncertain", "ses_acceptance_unknown"}
	}
	code, _, _ := strings.Cut(provider.GetCode(), ".")
	switch code {
	case "RequestLimitExceeded":
		return mailDeliveryResult{"retry", "ses_rate_limited"}
	case "AuthFailure", "UnauthorizedOperation", "InvalidParameter", "InvalidParameterValue", "MissingParameter", "LimitExceeded":
		return mailDeliveryResult{"failed", "ses_request_rejected"}
	}
	switch provider.GetCode() {
	case "FailedOperation.FrequencyLimit":
		return mailDeliveryResult{"retry", "ses_rate_limited"}
	case "FailedOperation.EmailAddrInBlacklist", "FailedOperation.ExceedSendLimit",
		"FailedOperation.IncorrectEmail", "FailedOperation.IncorrectSender",
		"FailedOperation.InsufficientBalance", "FailedOperation.InsufficientQuota",
		"FailedOperation.InvalidTemplateID", "FailedOperation.NotAuthenticatedSender",
		"FailedOperation.ReceiverHasUnsubscribed", "FailedOperation.WithOutPermission":
		return mailDeliveryResult{"failed", "ses_request_rejected"}
	default:
		return mailDeliveryResult{"uncertain", "ses_acceptance_unknown"}
	}
}
