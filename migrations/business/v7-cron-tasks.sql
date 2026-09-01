CREATE TABLE IF NOT EXISTS cron_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  scenario_id TEXT NOT NULL CHECK (scenario_id IN ('default','application')),
  resume_id TEXT,
  schedule_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','paused','completed','cancelled')),
  consumed_occurrences INTEGER NOT NULL DEFAULT 0 CHECK (consumed_occurrences >= 0),
  total_occurrences INTEGER NOT NULL CHECK (total_occurrences > 0),
  next_run_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_tasks_due ON cron_tasks(state, next_run_at);

CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY,
  cron_task_id TEXT NOT NULL REFERENCES cron_tasks(id),
  occurrence INTEGER NOT NULL CHECK (occurrence > 0),
  scheduled_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed','missed','needsAttention')),
  reason TEXT,
  conversation_id TEXT REFERENCES conversations(id),
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(cron_task_id, occurrence)
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_task ON cron_runs(cron_task_id, occurrence DESC);
