package purgearchive

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

var errInvalidReceipt = errors.New("invalid independent deletion receipt")

// Reject duplicate names before decoding. An allowlist also requires exact
// field names and non-null values. Credential metadata uses no allowlist.
func exactObject(data []byte, allowed ...string) (map[string]json.RawMessage, error) {
	if !utf8.Valid(data) {
		return nil, errInvalidReceipt
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if open, err := d.Token(); err != nil || open != json.Delim('{') {
		return nil, errInvalidReceipt
	}
	fields := make(map[string]json.RawMessage, len(allowed))
	for d.More() {
		token, err := d.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return nil, errInvalidReceipt
		}
		known := len(allowed) == 0
		for _, field := range allowed {
			if field == name {
				known = true
				break
			}
		}
		if !known || fields[name] != nil {
			return nil, errInvalidReceipt
		}
		var raw json.RawMessage
		if err := d.Decode(&raw); err != nil || len(allowed) != 0 && bytes.Equal(raw, []byte("null")) {
			return nil, errInvalidReceipt
		}
		fields[name] = raw
	}
	if close, err := d.Token(); err != nil || close != json.Delim('}') || d.Decode(new(any)) != io.EOF {
		return nil, errInvalidReceipt
	}
	return fields, nil
}

func decodeJSON(data []byte, dest any) error {
	if err := json.Unmarshal(data, dest); err != nil {
		return errInvalidReceipt
	}
	return nil
}

func parseID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || raw != id.String() {
		return uuid.Nil, errInvalidReceipt
	}
	return id, nil
}

func (a *OSS) validateReceipt(r Receipt) error {
	if err := r.validate(); err != nil {
		return err
	}
	for _, object := range r.Objects {
		prefix := a.location.ObjectPrefix
		if prefix == "" || !strings.HasPrefix(object.Key, prefix+"users/"+r.UserID.String()+"/") {
			return errors.New("deletion receipt object is outside the configured attachment prefix")
		}
		relative := strings.TrimPrefix(object.Key, prefix)
		parts := strings.Split(relative, "/")
		if len(parts) != 4 {
			return errInvalidReceipt
		}
		if _, err := parseID(parts[3]); err != nil {
			return err
		}
		if len(object.Version) > 1024 || strings.ContainsFunc(object.Version, unicode.IsControl) ||
			(parts[2] == "uploads" && object.Version != "") {
			return errInvalidReceipt
		}
	}
	return nil
}

func (a *OSS) decodeReceipt(data []byte, id uuid.UUID) (Receipt, error) {
	var receipt Receipt
	fields, err := exactObject(data, "schema_version", "operation_id", "user_id", "collection_id", "requested_at", "objects")
	if err != nil || len(fields) != 6 {
		return receipt, errInvalidReceipt
	}
	for _, key := range []string{"operation_id", "user_id", "collection_id"} {
		var value string
		if err := decodeJSON(fields[key], &value); err != nil {
			return receipt, err
		}
		if _, err := parseID(value); err != nil {
			return receipt, err
		}
	}
	objects := json.NewDecoder(bytes.NewReader(fields["objects"]))
	if open, err := objects.Token(); err != nil || open != json.Delim('[') {
		return receipt, errInvalidReceipt
	}
	for objects.More() {
		var raw json.RawMessage
		if err := objects.Decode(&raw); err != nil {
			return receipt, errInvalidReceipt
		}
		object, err := exactObject(raw, "key", "version", "not_before")
		if err != nil || object["key"] == nil {
			return receipt, errInvalidReceipt
		}
	}
	if err := decodeJSON(data, &receipt); err != nil {
		return receipt, err
	}
	if receipt.OperationID != id {
		return receipt, errors.New("deletion receipt identity mismatch")
	}
	return receipt, a.validateReceipt(receipt)
}

func canonicalReceipt(r Receipt) ([]byte, error) {
	r.RequestedAt = r.RequestedAt.UTC()
	objects := make([]Object, len(r.Objects))
	for i, object := range r.Objects {
		if object.NotBefore != nil {
			notBefore := object.NotBefore.UTC()
			object.NotBefore = &notBefore
		}
		objects[i] = object
	}
	r.Objects = objects
	data, err := json.Marshal(r)
	if err != nil || len(data) > maxReceiptBytes {
		return nil, errInvalidReceipt
	}
	return data, nil
}
