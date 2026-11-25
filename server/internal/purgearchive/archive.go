package purgearchive

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

const maxReceiptBytes = 64 << 20

type Receipt struct {
	SchemaVersion int       `json:"schema_version"`
	OperationID   uuid.UUID `json:"operation_id"`
	UserID        uuid.UUID `json:"user_id"`
	CollectionID  uuid.UUID `json:"collection_id"`
	RequestedAt   time.Time `json:"requested_at"`
	Objects       []Object  `json:"objects"`
}

type Object struct {
	Key       string     `json:"key"`
	Version   string     `json:"version,omitempty"`
	NotBefore *time.Time `json:"not_before,omitempty"`
}

type Archive interface {
	Close() error
	Put(context.Context, Receipt) error
	Read(context.Context, uuid.UUID) (Receipt, error)
	Each(context.Context, func(Receipt) error) error
}

type File struct{ root *os.Root }

func Open(dir string) (*File, error) {
	if !filepath.IsAbs(dir) {
		return nil, errors.New("an absolute deletion ledger directory is required")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("open independent deletion ledger: %w", err)
	}
	stat, err := root.Stat(".")
	if err != nil || stat.Mode().Perm()&0077 != 0 {
		root.Close()
		return nil, errors.New("deletion ledger directory must be private to its operator")
	}
	return &File{root: root}, nil
}

func (a *File) Close() error { return a.root.Close() }

// Put publishes one immutable receipt. The file and the directory entry are
// synced before a worker is allowed to erase objects or collection data.
func (a *File) Put(ctx context.Context, receipt Receipt) error {
	if err := receipt.validate(); err != nil {
		return err
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(data) > maxReceiptBytes {
		return errors.New("deletion receipt is too large")
	}
	temp := ".write-" + uuid.NewString()
	f, err := a.root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer a.root.Remove(temp)
	_, writeErr := f.Write(data)
	if err := errors.Join(writeErr, f.Sync(), f.Close()); err != nil {
		return err
	}
	if err := a.root.Link(temp, receipt.OperationID.String()+".json"); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		existing, err := a.Read(ctx, receipt.OperationID)
		if err != nil {
			return err
		}
		original, err := json.Marshal(existing)
		if err != nil || !bytes.Equal(original, data) {
			return errors.New("deletion receipt conflicts with existing copy")
		}
	}
	return a.sync()
}

func (a *File) sync() error {
	dir, err := a.root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (a *File) Read(_ context.Context, id uuid.UUID) (Receipt, error) {
	var receipt Receipt
	file, err := a.root.Open(id.String() + ".json")
	if err != nil {
		return receipt, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > maxReceiptBytes {
		return receipt, errors.New("invalid independent deletion receipt file")
	}
	decoder := json.NewDecoder(io.LimitReader(file, maxReceiptBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return receipt, errors.New("invalid independent deletion receipt")
	}
	if decoder.Decode(new(any)) != io.EOF || receipt.OperationID != id {
		return receipt, errors.New("deletion receipt identity mismatch")
	}
	return receipt, receipt.validate()
}

func (a *File) Each(ctx context.Context, visit func(Receipt) error) error {
	dir, err := a.root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		files, err := dir.ReadDir(64)
		if err != nil && err != io.EOF {
			return err
		}
		for _, file := range files {
			if err := ctx.Err(); err != nil {
				return err
			}
			name, ok := strings.CutSuffix(file.Name(), ".json")
			if !ok {
				continue
			}
			id, err := uuid.Parse(name)
			if err != nil || name != id.String() {
				return errors.New("invalid deletion receipt filename")
			}
			receipt, err := a.Read(ctx, id)
			if err != nil {
				return fmt.Errorf("read deletion operation %s: %w", id, err)
			}
			if err := visit(receipt); err != nil {
				return fmt.Errorf("replay deletion operation %s: %w", id, err)
			}
		}
		if err == io.EOF {
			return nil
		}
	}
}

func (r Receipt) validate() error {
	if r.SchemaVersion != 1 || r.OperationID == uuid.Nil || r.UserID == uuid.Nil ||
		r.CollectionID == uuid.Nil || r.RequestedAt.IsZero() {
		return errors.New("invalid deletion receipt identity")
	}
	seen := make(map[string]bool, len(r.Objects))
	for _, object := range r.Objects {
		parts := strings.Split(object.Key, "/")
		if len(parts) < 5 || strings.HasPrefix(object.Key, "/") || path.Clean(object.Key) != object.Key ||
			strings.ContainsAny(object.Key, "*?\\\x00") || parts[len(parts)-4] != "users" ||
			parts[len(parts)-3] != r.UserID.String() || seen[object.Key] {
			return errors.New("deletion receipt contains an object outside its account")
		}
		if _, err := uuid.Parse(parts[len(parts)-1]); err != nil {
			return errors.New("invalid deletion object identity")
		}
		kind := parts[len(parts)-2]
		if (kind == "uploads" && (object.NotBefore == nil || object.NotBefore.IsZero())) ||
			(kind == "attachments" && object.NotBefore != nil) ||
			(kind != "uploads" && kind != "attachments") {
			return errors.New("invalid deletion object lifetime")
		}
		seen[object.Key] = true
	}
	return nil
}
