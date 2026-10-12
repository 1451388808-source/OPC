CREATE TABLE IF NOT EXISTS project_thinking (
  project_id VARCHAR(16) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
