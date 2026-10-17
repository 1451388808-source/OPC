SET @work_item_position_lock_name = CONCAT(DATABASE(), ':008_work_item_position');
SELECT GET_LOCK(@work_item_position_lock_name, 30) INTO @work_item_position_lock_acquired;

SET @has_work_item_position = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_work_items'
    AND COLUMN_NAME = 'position'
);
SET @add_work_item_position = IF(
  @has_work_item_position = 0,
  'ALTER TABLE project_work_items ADD COLUMN position INT UNSIGNED NOT NULL DEFAULT 0 AFTER workflow_id',
  'SELECT 1'
);
PREPARE add_work_item_position_statement FROM @add_work_item_position;
EXECUTE add_work_item_position_statement;
DEALLOCATE PREPARE add_work_item_position_statement;

SET @has_work_item_position_index = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'project_work_items'
    AND INDEX_NAME = 'project_work_items_position'
);
SET @add_work_item_position_index = IF(
  @has_work_item_position_index = 0,
  'CREATE INDEX project_work_items_position ON project_work_items (workflow_id, position, id)',
  'SELECT 1'
);
PREPARE add_work_item_position_index_statement FROM @add_work_item_position_index;
EXECUTE add_work_item_position_index_statement;
DEALLOCATE PREPARE add_work_item_position_index_statement;

SELECT RELEASE_LOCK(@work_item_position_lock_name) INTO @work_item_position_lock_released;

