ALTER TABLE "natural_language_proposals" DROP CONSTRAINT "natural_language_proposals_lifecycle_valid";--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD COLUMN "result_schedule_block_id" uuid;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_result_schedule_block_tenant_fk" FOREIGN KEY ("workspace_id","result_schedule_block_id") REFERENCES "public"."schedule_blocks"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_lifecycle_valid" CHECK (COALESCE((
        ("natural_language_proposals"."status" = 'pending' AND "natural_language_proposals"."confirmation_key_hash" IS NULL AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."result_schedule_block_id" IS NULL AND "natural_language_proposals"."confirmed_at" IS NULL AND "natural_language_proposals"."cancelled_at" IS NULL)
        OR
        ("natural_language_proposals"."status" = 'confirmed' AND "natural_language_proposals"."confirmation_key_hash" IS NOT NULL AND "natural_language_proposals"."confirmed_at" IS NOT NULL AND "natural_language_proposals"."cancelled_at" IS NULL AND (
          (("natural_language_proposals"."command"->>'type') = 'work_item.create' AND "natural_language_proposals"."result_work_item_id" IS NOT NULL AND "natural_language_proposals"."result_schedule_block_id" IS NULL)
          OR
          (("natural_language_proposals"."command"->>'type') = 'schedule_block.create' AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."result_schedule_block_id" IS NOT NULL)
        ))
        OR
        ("natural_language_proposals"."status" = 'cancelled' AND "natural_language_proposals"."confirmation_key_hash" IS NULL AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."result_schedule_block_id" IS NULL AND "natural_language_proposals"."confirmed_at" IS NULL AND "natural_language_proposals"."cancelled_at" IS NOT NULL)
      ), false));
