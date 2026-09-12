CREATE TABLE IF NOT EXISTS boss_contact_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  proposal_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boss_contact_items (
  batch_id TEXT NOT NULL REFERENCES boss_contact_batches(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  step TEXT NOT NULL,
  result_json TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(batch_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_boss_contact_batches_session ON boss_contact_batches(session_id, created_at DESC);
