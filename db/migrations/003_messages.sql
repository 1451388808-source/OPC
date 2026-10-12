CREATE TABLE IF NOT EXISTS messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_id VARCHAR(64) NOT NULL,
  speaker ENUM('boss', 'employee') NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
