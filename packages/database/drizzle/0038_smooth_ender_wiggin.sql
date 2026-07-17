ALTER TABLE "natural_language_proposals" ADD COLUMN "model_suggestions_hash" varchar(64) DEFAULT '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b' NOT NULL;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD COLUMN "model_suggestions" jsonb;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_model_suggestions_hash_valid" CHECK ("natural_language_proposals"."model_suggestions_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_model_suggestions_object" CHECK ("natural_language_proposals"."model_suggestions" IS NULL OR jsonb_typeof("natural_language_proposals"."model_suggestions") = 'object');
