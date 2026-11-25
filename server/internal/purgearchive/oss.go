package purgearchive

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/google/uuid"
)

const receipts = "receipts/"

var (
	errAlreadyExists = errors.New("OSS rejected an existing deletion receipt key")
	errUnconfirmed   = errors.New("deletion ledger OSS write outcome is unconfirmed")
	errConflict      = errors.New("deletion receipt conflicts with existing copy")
)

type OSS struct {
	location   OSSLocation
	client     *oss.Client
	httpClient *http.Client
}

func (a *OSS) Location() OSSLocation { return a.location }

func (a *OSS) Close() error {
	a.httpClient.CloseIdleConnections()
	return nil
}

func (a *OSS) Check(ctx context.Context) error {
	// The SDK result omits an XML root constraint. Require the versioning
	// document explicitly so an unrelated 200 cannot pass as unversioned.
	out, err := a.client.InvokeOperation(ctx, &oss.OperationInput{
		OpName: "GetBucketVersioning", Method: http.MethodGet, Bucket: &a.location.Bucket,
		Parameters: map[string]string{"versioning": ""},
	})
	if err != nil {
		return storageError("query bucket versioning", err)
	}
	var state struct {
		XMLName xml.Name `xml:"VersioningConfiguration"`
		Text    string   `xml:",chardata"`
		Status  []struct {
			Text  string     `xml:",chardata"`
			Other []struct{} `xml:",any"`
		} `xml:"Status"`
		Other []struct{} `xml:",any"`
	}
	if !decodeOSSXML(out, 4096, &state) || strings.TrimSpace(state.Text) != "" ||
		len(state.Other) != 0 || len(state.Status) > 1 {
		return errors.New("invalid deletion ledger OSS bucket versioning response")
	}
	if len(state.Status) == 1 && (state.Status[0].Text != "" || len(state.Status[0].Other) != 0) {
		return errors.New("deletion ledger OSS requires a bucket that has never enabled versioning")
	}
	return nil
}

func (a *OSS) Put(ctx context.Context, receipt Receipt) error {
	if err := a.validateReceipt(receipt); err != nil {
		return err
	}
	return a.putAt(ctx, receipts, receipt)
}

func (a *OSS) putAt(ctx context.Context, namespace string, receipt Receipt) error {
	data, err := canonicalReceipt(receipt)
	if err != nil {
		return err
	}
	created := a.create(ctx, a.key(namespace, receipt.OperationID), data)
	if created != nil && !errors.Is(created, errAlreadyExists) && !errors.Is(created, errUnconfirmed) {
		return created
	}
	if err := a.confirm(ctx, namespace, receipt.OperationID, data); err != nil {
		if errors.Is(created, errUnconfirmed) || errors.Is(err, os.ErrNotExist) {
			return errors.Join(errUnconfirmed, err)
		}
		return err
	}
	return nil
}

func (a *OSS) key(namespace string, id uuid.UUID) string {
	return a.location.Prefix + namespace + id.String() + ".json"
}

func (a *OSS) create(ctx context.Context, key string, data []byte) error {
	if err := a.Check(ctx); err != nil {
		return err
	}
	result, err := a.client.PutObject(ctx, &oss.PutObjectRequest{
		Bucket: &a.location.Bucket, Key: &key, Body: bytes.NewReader(data),
		ContentLength: oss.Ptr(int64(len(data))), ContentType: oss.Ptr("application/json"),
		ForbidOverwrite: oss.Ptr("true"),
	})
	if err == nil {
		if result.VersionId != nil {
			return errors.New("deletion ledger OSS returned a versioned write")
		}
		return nil
	}
	var service *oss.ServiceError
	if errors.As(err, &service) {
		if service.StatusCode == http.StatusConflict && service.Code == "FileAlreadyExists" {
			return errAlreadyExists
		}
		if service.StatusCode >= 400 && service.StatusCode < 500 && service.StatusCode != http.StatusRequestTimeout {
			return storageError("create receipt", err)
		}
	}
	// The server may have persisted the request before the transport failed.
	// Perform no second write here. Only a matching readback can confirm it.
	return errUnconfirmed
}

func (a *OSS) confirm(ctx context.Context, namespace string, id uuid.UUID, data []byte) error {
	read, err := a.readAt(ctx, namespace, id)
	if err != nil {
		return err
	}
	existing, err := canonicalReceipt(read)
	if err != nil {
		return err
	}
	if !bytes.Equal(existing, data) {
		return errConflict
	}
	return nil
}

func (a *OSS) Read(ctx context.Context, id uuid.UUID) (Receipt, error) {
	return a.readAt(ctx, receipts, id)
}

func (a *OSS) readAt(ctx context.Context, namespace string, id uuid.UUID) (Receipt, error) {
	if id == uuid.Nil {
		return Receipt{}, errInvalidReceipt
	}
	key := a.key(namespace, id)
	result, err := a.client.GetObject(ctx, &oss.GetObjectRequest{Bucket: &a.location.Bucket, Key: &key})
	if err != nil {
		var service *oss.ServiceError
		if errors.As(err, &service) && service.StatusCode == http.StatusNotFound && service.Code == "NoSuchKey" {
			return Receipt{}, os.ErrNotExist
		}
		return Receipt{}, storageError("read receipt", err)
	}
	defer result.Body.Close()
	if result.StatusCode != http.StatusOK || result.VersionId != nil || result.ContentLength > maxReceiptBytes {
		return Receipt{}, errInvalidReceipt
	}
	data, err := io.ReadAll(io.LimitReader(result.Body, maxReceiptBytes+1))
	if err != nil || len(data) > maxReceiptBytes {
		return Receipt{}, errInvalidReceipt
	}
	return a.decodeReceipt(data, id)
}

func (a *OSS) Each(ctx context.Context, visit func(Receipt) error) error {
	return a.list(ctx, receipts, func(id uuid.UUID) error {
		receipt, err := a.Read(ctx, id)
		if err != nil {
			return fmt.Errorf("read deletion operation %s: %w", id, err)
		}
		if err := visit(receipt); err != nil {
			return fmt.Errorf("replay deletion operation %s: %w", id, err)
		}
		return nil
	})
}

func (a *OSS) list(ctx context.Context, namespace string, visit func(uuid.UUID) error) error {
	prefix := a.location.Prefix + namespace
	var lastKey, token string
	seenTokens := make(map[string]bool)
	for {
		page, err := a.listPage(ctx, prefix, token)
		if err != nil {
			return err
		}
		if *page.Truncated && seenTokens[page.NextToken] {
			return errors.New("repeated deletion ledger OSS continuation")
		}
		for _, object := range page.Contents {
			key := object.Key
			name, exact := strings.CutPrefix(key, prefix)
			rawID, jsonObject := strings.CutSuffix(name, ".json")
			id, err := parseID(rawID)
			if !exact || !jsonObject || err != nil || key <= lastKey {
				return errors.New("invalid or out-of-prefix deletion ledger OSS key")
			}
			lastKey = key
			if err := visit(id); err != nil {
				return err
			}
		}
		if !*page.Truncated {
			return nil
		}
		token = page.NextToken
		seenTokens[token] = true
	}
}

type ossListPage struct {
	XMLName        xml.Name   `xml:"ListBucketResult"`
	Bucket         string     `xml:"Name"`
	Prefix         string     `xml:"Prefix"`
	KeyCount       *int       `xml:"KeyCount"`
	Truncated      *bool      `xml:"IsTruncated"`
	Token          string     `xml:"ContinuationToken"`
	NextToken      string     `xml:"NextContinuationToken"`
	CommonPrefixes []struct{} `xml:"CommonPrefixes"`
	Contents       []struct {
		Key string `xml:"Key"`
	} `xml:"Contents"`
}

func (a *OSS) listPage(ctx context.Context, prefix, token string) (ossListPage, error) {
	var page ossListPage
	params := map[string]string{"list-type": "2", "prefix": prefix, "max-keys": "256"}
	if token != "" {
		params["continuation-token"] = token
	}
	out, err := a.client.InvokeOperation(ctx, &oss.OperationInput{
		OpName: "ListObjectsV2", Method: http.MethodGet, Bucket: &a.location.Bucket, Parameters: params,
	})
	if err != nil {
		return page, storageError("list receipts", err)
	}
	if !decodeOSSXML(out, 1<<20, &page) || page.Bucket != a.location.Bucket || page.Prefix != prefix ||
		page.KeyCount == nil || page.Truncated == nil || len(page.CommonPrefixes) != 0 ||
		*page.KeyCount != len(page.Contents) || len(page.Contents) > 256 ||
		page.Token != "" && page.Token != token {
		return page, errors.New("invalid deletion ledger OSS list response")
	}
	if *page.Truncated && (page.NextToken == "" || page.NextToken == token || len(page.Contents) == 0) ||
		!*page.Truncated && page.NextToken != "" {
		return page, errors.New("invalid deletion ledger OSS continuation")
	}
	return page, nil
}

func decodeOSSXML(out *oss.OperationOutput, limit int64, dest any) bool {
	if out.Body == nil {
		return false
	}
	defer out.Body.Close()
	if out.StatusCode != http.StatusOK {
		return false
	}
	data, err := io.ReadAll(io.LimitReader(out.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return false
	}
	d := xml.NewDecoder(bytes.NewReader(data))
	return d.Decode(dest) == nil && len(bytes.TrimSpace(data[d.InputOffset():])) == 0
}

func storageError(operation string, err error) error {
	var service *oss.ServiceError
	if errors.As(err, &service) && service.StatusCode >= 100 && service.StatusCode <= 599 {
		return fmt.Errorf("deletion ledger OSS %s failed (HTTP %d)", operation, service.StatusCode)
	}
	return fmt.Errorf("deletion ledger OSS %s failed", operation)
}
