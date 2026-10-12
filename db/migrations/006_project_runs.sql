CREATE TABLE IF NOT EXISTS project_runs (
  id VARCHAR(40) PRIMARY KEY,
  project_id VARCHAR(16) NOT NULL,
  task_id VARCHAR(16) NULL,
  role_id VARCHAR(64) NOT NULL,
  request_text TEXT NOT NULL,
  status ENUM('queued', 'running', 'review', 'applying', 'approved', 'returned', 'failed') NOT NULL,
  summary TEXT NOT NULL,
  error_text TEXT NOT NULL,
  return_reason TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  approved_at DATETIME(3) NULL,
  KEY project_runs_project (project_id, created_at),
  KEY project_runs_task (task_id, created_at),
  KEY project_runs_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_run_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id VARCHAR(40) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  body JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY project_run_events_run (run_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_run_files (
  run_id VARCHAR(40) NOT NULL,
  path VARCHAR(500) NOT NULL,
  operation ENUM('create', 'update') NOT NULL,
  before_sha256 CHAR(64) NULL,
  after_sha256 CHAR(64) NOT NULL,
  before_size BIGINT UNSIGNED NOT NULL,
  after_size BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (run_id, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
