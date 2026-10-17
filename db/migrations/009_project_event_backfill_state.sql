CREATE TABLE IF NOT EXISTS project_event_backfill_state (
  project_id VARCHAR(16) PRIMARY KEY,
  last_message_id BIGINT NOT NULL,
  last_run_event_id BIGINT NOT NULL,
  last_run_created_at DATETIME(3) NOT NULL,
  last_run_id VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

