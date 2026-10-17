CREATE TABLE IF NOT EXISTS project_workflows (
  id VARCHAR(40) PRIMARY KEY,
  project_id VARCHAR(16) NOT NULL,
  task_id VARCHAR(16) NULL,
  source_event_id BIGINT NULL,
  title VARCHAR(300) NOT NULL,
  request_text TEXT NOT NULL,
  coordinator_role_id VARCHAR(64) NOT NULL,
  status ENUM(
    'intake',
    'planning',
    'collaborating',
    'waiting_user',
    'verifying',
    'review',
    'applying',
    'approved',
    'returned',
    'failed',
    'cancelled'
  ) NOT NULL,
  summary TEXT NOT NULL,
  error_text TEXT NOT NULL,
  return_reason TEXT NOT NULL,
  cancel_reason TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  approved_at DATETIME(3) NULL,
  KEY project_workflows_project (project_id, created_at),
  KEY project_workflows_task (task_id, created_at),
  KEY project_workflows_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_work_items (
  id VARCHAR(40) PRIMARY KEY,
  workflow_id VARCHAR(40) NOT NULL,
  position INT UNSIGNED NOT NULL,
  title VARCHAR(300) NOT NULL,
  objective TEXT NOT NULL,
  acceptance JSON NOT NULL,
  owner_role_id VARCHAR(64) NOT NULL,
  reviewer_role_id VARCHAR(64) NULL,
  status ENUM('queued', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled') NOT NULL,
  blocked_reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence JSON NOT NULL,
  error_text TEXT NOT NULL,
  retry_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY project_work_items_workflow (workflow_id, position, id),
  KEY project_work_items_owner (owner_role_id, status),
  KEY project_work_items_status (workflow_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_work_item_dependencies (
  work_item_id VARCHAR(40) NOT NULL,
  depends_on_work_item_id VARCHAR(40) NOT NULL,
  PRIMARY KEY (work_item_id, depends_on_work_item_id),
  KEY project_work_item_dependencies_parent (depends_on_work_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id VARCHAR(16) NOT NULL,
  workflow_id VARCHAR(40) NULL,
  work_item_id VARCHAR(40) NULL,
  actor_type ENUM('boss', 'agent', 'system', 'tool') NOT NULL,
  actor_id VARCHAR(128) NULL,
  kind VARCHAR(48) NOT NULL,
  body JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY project_events_project (project_id, id),
  KEY project_events_workflow (workflow_id, id),
  KEY project_events_work_item (work_item_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_event_sources (
  source_type VARCHAR(48) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  project_event_id BIGINT NOT NULL,
  PRIMARY KEY (source_type, source_id),
  UNIQUE KEY project_event_sources_event (project_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_decision_requests (
  id VARCHAR(40) PRIMARY KEY,
  workflow_id VARCHAR(40) NOT NULL,
  work_item_id VARCHAR(40) NULL,
  asked_by_role_id VARCHAR(64) NOT NULL,
  question TEXT NOT NULL,
  options JSON NOT NULL,
  recommendation VARCHAR(100) NOT NULL,
  reason TEXT NOT NULL,
  blocking_work_item_ids JSON NOT NULL,
  status ENUM('open', 'resolved', 'cancelled') NOT NULL,
  answer TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  KEY project_decision_requests_workflow (workflow_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id VARCHAR(40) PRIMARY KEY,
  workflow_id VARCHAR(40) NOT NULL,
  work_item_id VARCHAR(40) NULL,
  created_by_role_id VARCHAR(64) NOT NULL,
  kind VARCHAR(48) NOT NULL,
  relative_ref VARCHAR(700) NOT NULL,
  sha256 CHAR(64) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  metadata JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY workflow_artifacts_workflow (workflow_id, created_at),
  KEY workflow_artifacts_work_item (work_item_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  transport ENUM('stdio', 'streamable_http') NOT NULL,
  config JSON NOT NULL,
  enabled BOOLEAN NOT NULL,
  discovered_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_tools (
  server_id VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  input_schema JSON NOT NULL,
  schema_sha256 CHAR(64) NOT NULL,
  risk_level ENUM('read', 'reversible_write', 'controlled_execute', 'external_action') NOT NULL,
  policy ENUM('allow', 'confirm', 'deny') NOT NULL,
  enabled BOOLEAN NOT NULL,
  discovered_at DATETIME(3) NOT NULL,
  PRIMARY KEY (server_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  project_id VARCHAR(16) NOT NULL,
  workflow_id VARCHAR(40) NOT NULL,
  work_item_id VARCHAR(40) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  server_id VARCHAR(64) NOT NULL,
  tool_name VARCHAR(200) NOT NULL,
  policy_result ENUM('allow', 'confirm', 'deny') NOT NULL,
  arguments_summary JSON NOT NULL,
  status ENUM('requested', 'running', 'succeeded', 'failed', 'cancelled', 'denied') NOT NULL,
  result_summary JSON NULL,
  error_text TEXT NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  KEY mcp_tool_calls_workflow (workflow_id, id),
  KEY mcp_tool_calls_work_item (work_item_id, id),
  KEY mcp_tool_calls_server (server_id, tool_name, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

