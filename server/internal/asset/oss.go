package asset

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

var (
	ErrObjectMissing = errors.New("storage object missing")
	ErrSizeMismatch  = errors.New("storage object size mismatch")
)

type Grant struct {
	URL       string
	Headers   map[string]string
	ExpiresAt time.Time
}

// Storage operations receive server-generated object keys. The implementation
// grants each operation only the actions and exact keys it needs.
type Storage interface {
	Keys(userID, uploadID string) (staging, final string)
	SignPut(context.Context, string, string, int64, time.Time) (Grant, error)
	SignGet(context.Context, string, string) (Grant, error)
	OpenFinal(context.Context, string, string, string, int64) (io.ReadCloser, string, error)
	ReadFinal(context.Context, string, string, int64) (io.ReadCloser, error)
	Delete(context.Context, string, string) error
}

type OSS struct {
	config
	client *oss.Client
}

func newOSS(c config, key accessKey) *OSS {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	httpClient := &http.Client{
		Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	cfg := oss.LoadDefaultConfig().WithCredentialsProvider(credentials.NewStaticCredentialsProvider(key.ID, key.Secret)).
		WithRegion(c.OSSRegion).WithEndpoint(c.OSSEndpoint).WithUseCName(c.OSSUseCNAME).
		WithHttpClient(httpClient).WithRetryMaxAttempts(1).WithSignatureVersion(oss.SignatureVersionV4).
		WithAdditionalHeaders([]string{"content-length"})
	return &OSS{config: c, client: oss.NewClient(cfg)}
}

func (s *OSS) Keys(uid, uploadID string) (string, string) {
	dir := s.Prefix + "users/" + uid
	return dir + "/uploads/" + uploadID, dir + "/attachments/" + uploadID
}

const uuidPart = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

var objectPath = regexp.MustCompile(`^users/` + uuidPart + `/(uploads|attachments)/` + uuidPart + `$`)
var errObjectScope = errors.New("invalid OSS object for this operation")

// Include the environment prefix in every check, including keys read from old
// jobs or deletion receipts. Only the two server-generated paths are valid.
func (s *OSS) keyKind(key string) string {
	relative, ok := strings.CutPrefix(key, s.Prefix)
	if !ok {
		return ""
	}
	match := objectPath.FindStringSubmatch(relative)
	if match == nil {
		return ""
	}
	return match[1]
}

func (s *OSS) SignPut(ctx context.Context, key, mime string, size int64, expires time.Time) (Grant, error) {
	if s.keyKind(key) != "uploads" {
		return Grant{}, errObjectScope
	}
	grant, err := presign(ctx, s.client, &oss.PutObjectRequest{
		Bucket: &s.Bucket, Key: &key, ContentType: &mime, ContentLength: &size,
	}, minTime(expires, time.Now().Add(time.Duration(s.PutTTL)*time.Second)))
	if err != nil {
		return Grant{}, err
	}
	// XHR sends Content-Length for the Blob. It cannot set the header itself.
	for header := range grant.Headers {
		if strings.EqualFold(header, "Content-Length") {
			delete(grant.Headers, header)
		}
	}
	return grant, nil
}

func (s *OSS) SignGet(ctx context.Context, key, version string) (Grant, error) {
	if s.keyKind(key) != "attachments" {
		return Grant{}, errObjectScope
	}
	return presign(ctx, s.client, &oss.GetObjectRequest{
		Bucket: &s.Bucket, Key: &key, VersionId: versionID(version),
		ResponseCacheControl: oss.Ptr("private, no-store"),
	}, time.Now().Add(time.Duration(s.GetTTL)*time.Second))
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func presign(ctx context.Context, client *oss.Client, req any, expires time.Time) (Grant, error) {
	expires = expires.UTC().Truncate(time.Second)
	if !expires.After(time.Now()) {
		return Grant{}, errors.New("OSS authorization expired")
	}
	result, err := client.Presign(ctx, req, oss.PresignExpiration(expires))
	if err != nil {
		return Grant{}, errors.New("OSS signing failed")
	}
	if result.SignedHeaders == nil {
		result.SignedHeaders = map[string]string{}
	}
	return Grant{URL: result.URL, Headers: result.SignedHeaders, ExpiresAt: expires}, nil
}

// OpenFinal reads the existing destination on retries. Copy preconditions
// pin the staging candidate, and the browser's PUT scope cannot reach final.
func (s *OSS) OpenFinal(ctx context.Context, staging, final, mime string, size int64) (io.ReadCloser, string, error) {
	if s.keyKind(staging) != "uploads" {
		return nil, "", errObjectScope
	}
	// Derive the destination from the validated source, preserving the user and upload IDs.
	wantFinal := s.Prefix + strings.Replace(strings.TrimPrefix(staging, s.Prefix), "/uploads/", "/attachments/", 1)
	if final != wantFinal {
		return nil, "", errObjectScope
	}
	head, err := s.client.HeadObject(ctx, &oss.HeadObjectRequest{Bucket: &s.Bucket, Key: &final})
	if status(err) == http.StatusNotFound {
		source, err := s.client.HeadObject(ctx, &oss.HeadObjectRequest{Bucket: &s.Bucket, Key: &staging})
		if err != nil {
			return nil, "", objectError("inspect staging object", err)
		}
		if source.ContentLength != size {
			return nil, "", ErrSizeMismatch
		}
		if value(source.ETag) == "" {
			return nil, "", errors.New("missing OSS staging object ETag")
		}
		_, err = s.client.CopyObject(ctx, &oss.CopyObjectRequest{
			Bucket: &s.Bucket, Key: &final, SourceBucket: &s.Bucket, SourceKey: &staging,
			IfMatch: source.ETag, ForbidOverwrite: oss.Ptr("true"), MetadataDirective: oss.Ptr("REPLACE"),
			ContentType: &mime, CacheControl: oss.Ptr("private, no-store"),
		})
		if err != nil && status(err) != http.StatusConflict {
			return nil, "", objectError("copy staging object", err)
		}
	} else if err != nil {
		return nil, "", objectError("inspect final object", err)
	} else if head.ContentLength != size {
		return nil, "", ErrSizeMismatch
	}
	result, err := s.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: &s.Bucket, Key: &final})
	if err != nil {
		return nil, "", objectError("read final object", err)
	}
	if result.ContentLength != size {
		result.Body.Close()
		return nil, value(result.VersionId), ErrSizeMismatch
	}
	return result.Body, value(result.VersionId), nil
}

// ReadFinal grants read access only to the already confirmed object version.
func (s *OSS) ReadFinal(ctx context.Context, key, version string, size int64) (io.ReadCloser, error) {
	if s.keyKind(key) != "attachments" {
		return nil, errObjectScope
	}
	result, err := s.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: &s.Bucket, Key: &key, VersionId: versionID(version)})
	if err != nil {
		return nil, objectError("read confirmed object", err)
	}
	if result.ContentLength != size || (version != "" && value(result.VersionId) != version) {
		result.Body.Close()
		return nil, ErrSizeMismatch
	}
	return result.Body, nil
}

func (s *OSS) Delete(ctx context.Context, key, version string) error {
	if s.keyKind(key) == "" {
		return errObjectScope
	}
	_, err := s.client.DeleteObject(ctx, &oss.DeleteObjectRequest{Bucket: &s.Bucket, Key: &key, VersionId: versionID(version)})
	if err != nil && status(err) != http.StatusNotFound {
		return objectError("delete object", err)
	}
	return nil
}

func versionID(version string) *string {
	if version == "" {
		return nil
	}
	return &version
}

func status(err error) int {
	var service *oss.ServiceError
	if errors.As(err, &service) {
		return service.StatusCode
	}
	return 0
}

func objectError(action string, err error) error {
	if code := status(err); code == http.StatusNotFound {
		return ErrObjectMissing
	} else if code != 0 {
		return fmt.Errorf("OSS %s returned HTTP %d", action, code)
	}
	return fmt.Errorf("OSS %s failed", action)
}

func value(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
