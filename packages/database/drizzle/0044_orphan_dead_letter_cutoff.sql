-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: source-deleted dead letters must be permanently ineligible for a new provider attempt
UPDATE "notification_delivery_commands" AS command
SET
  "status" = 'invalidated',
  "redrive_requested_at" = NULL,
  "completed_at" = greatest(clock_timestamp(), command."created_at", command."updated_at"),
  "updated_at" = greatest(clock_timestamp(), command."created_at", command."updated_at")
WHERE command."status" = 'dead_letter'
  AND NOT EXISTS (
    SELECT 1
    FROM "notification_intents" AS intent
    WHERE intent."workspace_id" = command."workspace_id"
      AND intent."id" = command."intent_id"
  );
