CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(16) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  brief TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance JSON NOT NULL,
  role VARCHAR(64) NOT NULL,
  status ENUM('inbox', 'doing', 'review', 'blocked', 'done') NOT NULL,
  priority ENUM('now', 'next', 'later') NOT NULL,
  artifacts JSON NOT NULL,
  notes TEXT NOT NULL,
  needs_approval TINYINT(1) NOT NULL,
  block_reason TEXT NOT NULL,
  decision TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS decisions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  decided_on DATE NOT NULL,
  title VARCHAR(200) NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  task_id VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goals (
  id TINYINT PRIMARY KEY,
  quarter_text TEXT NOT NULL,
  week_focus TEXT NOT NULL,
  week_start DATE NULL,
  week_end DATE NULL,
  out_of_scope TEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS counters (
  name VARCHAR(32) PRIMARY KEY,
  value INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
