ALTER TABLE cron_tasks ADD COLUMN browser_authorized INTEGER NOT NULL DEFAULT 0 CHECK (browser_authorized IN (0, 1));
