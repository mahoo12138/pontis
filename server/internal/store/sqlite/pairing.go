package sqlite

// Pairing-code persistence: the store half of device.PairingStore. Codes are
// hashed, single-use and short-lived — the same lifecycle as password reset
// tokens, and the same atomic consume-or-lose discipline.

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"

	"pontis/internal/device"
)

// InsertPairingCode stores one code hash for the user, sweeping expired and
// spent rows on the way: nothing else reads this table by age.
func (s *DeviceStore) InsertPairingCode(ctx context.Context, userID, codeHash string, expiresAt, at time.Time) error {
	if _, err := s.db.ExecContext(ctx, `
		DELETE FROM device_pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL`,
		formatTime(at)); err != nil {
		return err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO device_pairing_codes (id, user_id, code_hash, expires_at, used_at, created_at)
		VALUES (?, ?, ?, ?, NULL, ?)`,
		id.String(), userID, codeHash, formatTime(expiresAt), formatTime(at))
	return err
}

// ConsumePairingCode marks a code used and returns its owner in one
// transaction. Two extensions redeeming the same code must yield exactly one
// winner: the guarded UPDATE decides, like the reset-token flow does.
func (s *DeviceStore) ConsumePairingCode(ctx context.Context, codeHash string, at time.Time) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck // after Commit it is a no-op

	var id, userID string
	err = tx.QueryRowContext(ctx, `
		SELECT id, user_id FROM device_pairing_codes
		WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
		codeHash, formatTime(at)).Scan(&id, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", device.ErrPairingCodeInvalid
	}
	if err != nil {
		return "", err
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE device_pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL`,
		formatTime(at), id)
	if err != nil {
		return "", err
	}
	if won, err := res.RowsAffected(); err != nil {
		return "", err
	} else if won == 0 {
		return "", device.ErrPairingCodeInvalid
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}
