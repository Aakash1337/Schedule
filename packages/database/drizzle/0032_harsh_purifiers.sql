ALTER TABLE "natural_language_proposals" ADD COLUMN IF NOT EXISTS "review_hash" varchar(64) DEFAULT '65f7aef345c4f828788d1f4b3d779476b02a9599c31b1442ac7a4b3dbd670805' NOT NULL;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD COLUMN IF NOT EXISTS "review_priority" "work_item_priority" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD COLUMN IF NOT EXISTS "review_due_on" date;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD COLUMN IF NOT EXISTS "review_planning_duration_minutes" integer;--> statement-breakpoint
DO $$
DECLARE
  review_hash_type text;
  review_priority_type text;
  review_due_on_type text;
  review_duration_type text;
BEGIN
  SELECT format_type(atttypid, atttypmod) INTO review_hash_type
  FROM pg_attribute
  WHERE attrelid = 'natural_language_proposals'::regclass
    AND attname = 'review_hash'
    AND NOT attisdropped;

  SELECT format_type(atttypid, atttypmod) INTO review_priority_type
  FROM pg_attribute
  WHERE attrelid = 'natural_language_proposals'::regclass
    AND attname = 'review_priority'
    AND NOT attisdropped;

  SELECT format_type(atttypid, atttypmod) INTO review_due_on_type
  FROM pg_attribute
  WHERE attrelid = 'natural_language_proposals'::regclass
    AND attname = 'review_due_on'
    AND NOT attisdropped;

  SELECT format_type(atttypid, atttypmod) INTO review_duration_type
  FROM pg_attribute
  WHERE attrelid = 'natural_language_proposals'::regclass
    AND attname = 'review_planning_duration_minutes'
    AND NOT attisdropped;

  IF review_hash_type IS DISTINCT FROM 'character varying(64)'
    OR review_priority_type IS DISTINCT FROM 'work_item_priority'
    OR review_due_on_type IS DISTINCT FROM 'date'
    OR review_duration_type IS DISTINCT FROM 'integer'
  THEN
    RAISE EXCEPTION 'natural-language proposal review columns have incompatible types';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "natural_language_proposals"
  ALTER COLUMN "review_hash" SET DEFAULT '65f7aef345c4f828788d1f4b3d779476b02a9599c31b1442ac7a4b3dbd670805',
  ALTER COLUMN "review_hash" SET NOT NULL,
  ALTER COLUMN "review_priority" SET DEFAULT 'none',
  ALTER COLUMN "review_priority" SET NOT NULL,
  ALTER COLUMN "review_due_on" DROP DEFAULT,
  ALTER COLUMN "review_due_on" DROP NOT NULL,
  ALTER COLUMN "review_planning_duration_minutes" DROP DEFAULT,
  ALTER COLUMN "review_planning_duration_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" DROP CONSTRAINT IF EXISTS "natural_language_proposals_review_hash_valid";--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_review_hash_valid" CHECK ("natural_language_proposals"."review_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "natural_language_proposals" DROP CONSTRAINT IF EXISTS "natural_language_proposals_review_duration_valid";--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_review_duration_valid" CHECK ("natural_language_proposals"."review_planning_duration_minutes" IS NULL OR ("natural_language_proposals"."review_planning_duration_minutes" > 0 AND "natural_language_proposals"."review_planning_duration_minutes" <= 43200));
