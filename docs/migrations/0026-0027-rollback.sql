-- Reverse of drizzle/0026_syllabus_core.sql and drizzle/0027_learning_activity.sql (Syllabus phase 1).
-- First choice is simply turning the SYLLABUS flag off: the tables are add-only and unused while it is off.
-- Use this only if the feature is abandoned. Nothing is lost: the tables are renamed to _rollback_0026_* /
-- _rollback_0027_*; review and drop them once the decision is final.
-- Syllabus practice containers stay in `tasks` (hidden, no students); the pre-0026 app shows them in the
-- teacher's task list. List them before deciding:
--   SELECT taskId FROM syllabus_practice_tasks;
-- The SYLLABUS_ENABLED_WORKSPACES env var and any feature_flag_overrides rows with flagKey='SYLLABUS' can stay.

RENAME TABLE
  `learning_activity` TO `_rollback_0027_learning_activity`,
  `group_learning_settings` TO `_rollback_0026_group_learning_settings`,
  `syllabi` TO `_rollback_0026_syllabi`,
  `syllabus_access_grants` TO `_rollback_0026_syllabus_access_grants`,
  `syllabus_approvals` TO `_rollback_0026_syllabus_approvals`,
  `syllabus_assessment_assignments` TO `_rollback_0026_syllabus_assessment_assignments`,
  `syllabus_completions` TO `_rollback_0026_syllabus_completions`,
  `syllabus_enrollments` TO `_rollback_0026_syllabus_enrollments`,
  `syllabus_item_progress` TO `_rollback_0026_syllabus_item_progress`,
  `syllabus_items` TO `_rollback_0026_syllabus_items`,
  `syllabus_lesson_progress` TO `_rollback_0026_syllabus_lesson_progress`,
  `syllabus_lessons` TO `_rollback_0026_syllabus_lessons`,
  `syllabus_manual_unlocks` TO `_rollback_0026_syllabus_manual_unlocks`,
  `syllabus_module_progress` TO `_rollback_0026_syllabus_module_progress`,
  `syllabus_modules` TO `_rollback_0026_syllabus_modules`,
  `syllabus_practice_tasks` TO `_rollback_0026_syllabus_practice_tasks`,
  `syllabus_version_items` TO `_rollback_0026_syllabus_version_items`,
  `syllabus_versions` TO `_rollback_0026_syllabus_versions`;

-- The 0026 and 0027 journal rows (journal "when" = 1791101322726 and 1791101337504).
DELETE FROM `__drizzle_migrations` WHERE `created_at` IN (1791101322726, 1791101337504);
