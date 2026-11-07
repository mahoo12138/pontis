package device

// Pairing codes. A one-time, short-lived secret generated in the web console
// that a client which cannot hold a web session — the extension — redeems for
// a device credential. They exist so nobody has to type their account
// password into the extension, and so an SSO-provisioned account, which has
// no password at all, can still pair a device.

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"time"

	"pontis/internal/canonical"
)

// pairingCodeTTL is how long a generated code may sit before the extension
// redeems it.
const pairingCodeTTL = 10 * time.Minute

// pairingCodeLen is the code length: 8 chars over a 32-char alphabet is 40
// bits, enough for a secret that lives ten minutes and works once.
const pairingCodeLen = 8

// pairingAlphabet drops 0/O/1/I/L so a code read off one screen types
// cleanly into another.
const pairingAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// PairingStore is the persistence contract for pairing codes, implemented by
// the sqlite device store and asserted from s.store.
type PairingStore interface {
	// InsertPairingCode stores a code hash for the user.
	InsertPairingCode(ctx context.Context, userID, codeHash string, expiresAt, at time.Time) error
	// ConsumePairingCode atomically marks a code used and returns its owner.
	ConsumePairingCode(ctx context.Context, codeHash string, at time.Time) (string, error)
}

// CreatePairingCode mints a single-use code for the signed-in user and
// returns it in display form (XXXX-XXXX) together with its expiry. The raw
// code is never stored; only its SHA-256 hash is.
func (s *Service) CreatePairingCode(ctx context.Context, userID string) (string, time.Time, error) {
	ps, ok := s.store.(PairingStore)
	if !ok {
		return "", time.Time{}, ErrPairingUnavailable
	}
	raw, err := randomPairingCode()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(pairingCodeTTL)
	if err := ps.InsertPairingCode(ctx, userID, hashToken(raw), expiresAt, now); err != nil {
		return "", time.Time{}, err
	}
	return displayPairingCode(raw), expiresAt, nil
}

// PairWithCode consumes a code and registers the device it was meant for.
// The code burns before the device is created: a registration that fails
// after consumption asks the person for a fresh code, which is the safe
// direction — a code that already registered a device must never validate
// again, even if its response was lost on the wire.
func (s *Service) PairWithCode(ctx context.Context, rawCode, name, clientType, browser, platform string) (Device, string, error) {
	ps, ok := s.store.(PairingStore)
	if !ok {
		return Device{}, "", ErrPairingUnavailable
	}
	code := normalizePairingCode(rawCode)
	if len(code) != pairingCodeLen {
		return Device{}, "", ErrPairingCodeInvalid
	}
	userID, err := ps.ConsumePairingCode(ctx, hashToken(code), time.Now().UTC())
	if err != nil {
		return Device{}, "", err
	}
	return s.RegisterDevice(ctx, canonical.UserID(userID), name, clientType, browser, platform)
}

// randomPairingCode returns eight unambiguous characters of CSPRNG.
func randomPairingCode() (string, error) {
	var b strings.Builder
	for i := 0; i < pairingCodeLen; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(pairingAlphabet))))
		if err != nil {
			return "", fmt.Errorf("device: read pairing code entropy: %w", err)
		}
		b.WriteByte(pairingAlphabet[n.Int64()])
	}
	return b.String(), nil
}

// normalizePairingCode uppercases and strips separators, so the code works
// with or without the dash and in any case the typist produced.
func normalizePairingCode(code string) string {
	var b strings.Builder
	for _, c := range strings.ToUpper(strings.TrimSpace(code)) {
		switch c {
		case '-', ' ':
		default:
			b.WriteRune(c)
		}
	}
	return b.String()
}

// displayPairingCode groups the code for reading aloud and typing: XXXX-XXXX.
func displayPairingCode(code string) string {
	if len(code) != pairingCodeLen {
		return code
	}
	half := pairingCodeLen / 2
	return code[:half] + "-" + code[half:]
}
