PRAGMA foreign_keys = ON;

ALTER TABLE inbox_receipts ADD COLUMN dedupe_key TEXT;
ALTER TABLE inbox_receipts ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox_receipts ADD COLUMN last_received_at TEXT;
ALTER TABLE inbox_receipts ADD COLUMN outcome TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE inbox_receipts ADD COLUMN queue_state TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE inbox_receipts ADD COLUMN queue_claim_token TEXT;
ALTER TABLE inbox_receipts ADD COLUMN queue_claimed_at TEXT;

UPDATE inbox_receipts
SET last_received_at = received_at
WHERE last_received_at IS NULL;

UPDATE inbox_receipts
SET outcome = 'legacy-duplicate'
WHERE message_id IS NOT NULL
  AND trim(message_id) <> ''
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM inbox_receipts
    WHERE message_id IS NOT NULL AND trim(message_id) <> ''
    GROUP BY source_id, lower(trim(message_id))
  );

UPDATE inbox_receipts
SET dedupe_key = source_id || ':' || lower(trim(message_id)),
    delivery_count = (
      SELECT COUNT(*)
      FROM inbox_receipts AS candidate
      WHERE candidate.source_id = inbox_receipts.source_id
        AND lower(trim(candidate.message_id)) = lower(trim(inbox_receipts.message_id))
    ),
    outcome = CASE
      WHEN (
        SELECT COUNT(*)
        FROM inbox_receipts AS candidate
        WHERE candidate.source_id = inbox_receipts.source_id
          AND lower(trim(candidate.message_id)) = lower(trim(inbox_receipts.message_id))
      ) > 1 THEN 'duplicate-reused'
      ELSE 'queued'
    END
WHERE message_id IS NOT NULL
  AND trim(message_id) <> ''
  AND rowid IN (
    SELECT MIN(rowid)
    FROM inbox_receipts
    WHERE message_id IS NOT NULL AND trim(message_id) <> ''
    GROUP BY source_id, lower(trim(message_id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_receipts_dedupe
  ON inbox_receipts(dedupe_key);

INSERT INTO settings(key, value, updated_at)
VALUES ('schema_version', '18', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
