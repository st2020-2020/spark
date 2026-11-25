package purgearchive

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

const probes = "probes/"

func probeReceipt(id uuid.UUID) Receipt {
	return Receipt{
		SchemaVersion: 1, OperationID: id, UserID: id, CollectionID: id,
		RequestedAt: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

// Probe certifies condition enforcement with two independent requests for the
// same fresh, synthetic key. A transport-ambiguous result cannot certify it.
func (a *OSS) Probe(ctx context.Context, id uuid.UUID) error {
	if id == uuid.Nil {
		return errInvalidReceipt
	}
	receipt := probeReceipt(id)
	data, err := canonicalReceipt(receipt)
	if err != nil {
		return err
	}
	key := a.key(probes, id)
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- a.create(ctx, key, data) }()
	}
	first, second := <-results, <-results
	if !(first == nil && errors.Is(second, errAlreadyExists) ||
		second == nil && errors.Is(first, errAlreadyExists)) {
		return errors.Join(errors.New("OSS probe requires one successful create and one FileAlreadyExists for a fresh UUID"), first, second)
	}
	receipt.RequestedAt = receipt.RequestedAt.Add(time.Second)
	conflict, err := canonicalReceipt(receipt)
	if err != nil {
		return err
	}
	if err := a.create(ctx, key, conflict); !errors.Is(err, errAlreadyExists) {
		return errors.Join(errors.New("OSS probe did not reject an attempt to replace the original"), err)
	}
	return a.VerifyProbe(ctx, id)
}

func (a *OSS) VerifyProbe(ctx context.Context, id uuid.UUID) error {
	data, err := canonicalReceipt(probeReceipt(id))
	if err != nil {
		return err
	}
	if err := a.confirm(ctx, probes, id, data); err != nil {
		return errors.Join(errors.New("cannot read back the expected synthetic deletion ledger probe"), err)
	}
	found := false
	if err := a.list(ctx, probes, func(candidate uuid.UUID) error {
		found = found || candidate == id
		return nil
	}); err != nil {
		return err
	}
	if !found {
		return errors.New("synthetic deletion ledger probe is missing from the OSS listing")
	}
	return nil
}
