-- 000024_activity: browsing statistics uploaded by the extension
-- (core/activity). The client is the source of truth for its own numbers:
-- a batch entry REPLACES the stored rows for (device, day) in one
-- transaction, so a re-sent day corrects instead of duplicating and no
-- increment ledger is needed server-side.
--
-- Two privacy properties are structural here. The granularity is day × host
-- — there is no table a URL could go into, because the wire format has no
-- URL field. And every row hangs off the device it came from: deleting the
-- device record (account-side 设备页) cascades away the statistics that
-- device uploaded, so "remove this device" also means "remove its traces".

CREATE TABLE activity_daily (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day       TEXT NOT NULL,
    host      TEXT NOT NULL,
    seconds   INTEGER NOT NULL,
    visits    INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, day, host)
);

CREATE INDEX idx_activity_daily_user_day
    ON activity_daily(user_id, day);

CREATE TABLE activity_hourly (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day       TEXT NOT NULL,
    hour      INTEGER NOT NULL,
    seconds   INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, day, hour)
);

CREATE INDEX idx_activity_hourly_user_day
    ON activity_hourly(user_id, day);

-- One row per (request, day) as the ingest audit trail: what arrived, from
-- which device, when, how big. The batch id is minted per request; the
-- ledger is for operators, not for dedupe — replace-per-day is already
-- idempotent on its own.
CREATE TABLE activity_batches (
    batch_id    TEXT NOT NULL,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    rows        INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (batch_id, day)
);

CREATE INDEX idx_activity_batches_device
    ON activity_batches(device_id, received_at DESC);
