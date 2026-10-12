CREATE TABLE IF NOT EXISTS companies (
  id VARCHAR(16) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(16) PRIMARY KEY,
  company_id VARCHAR(16) NOT NULL,
  name VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY projects_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_members (
  project_id VARCHAR(16) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id VARCHAR(16) NOT NULL,
  speaker ENUM('boss', 'employee') NOT NULL,
  role_id VARCHAR(64) NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY project_messages_project (project_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
