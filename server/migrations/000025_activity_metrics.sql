-- 000025_activity_metrics: the focus-quality side of a day's upload —
-- how many tab switches the tracker saw and how long the single longest
-- dwell episode ran. Both are per (device, day) and replaced with the same
-- batch that replaces the host rows: one day, one truth. A host label never
-- meets a clock position here any more than it does in activity_hourly.

CREATE TABLE activity_metrics (
    user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id             TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day                   TEXT NOT NULL,
    switches              INTEGER NOT NULL DEFAULT 0,
    longest_focus_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id, day)
);

CREATE INDEX idx_activity_metrics_user_day
    ON activity_metrics(user_id, day);
