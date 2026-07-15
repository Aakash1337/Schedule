CREATE TYPE "public"."browser_session_revocation_reason" AS ENUM('signed_out', 'rotated', 'user_disabled', 'administrative');--> statement-breakpoint
CREATE TYPE "public"."hosted_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."workspace_membership_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret_digest" varchar(64) NOT NULL,
	"idle_timeout_seconds" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" "browser_session_revocation_reason",
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "browser_sessions_secret_digest_uq" UNIQUE("secret_digest"),
	CONSTRAINT "browser_sessions_digest_valid" CHECK ("browser_sessions"."secret_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "browser_sessions_idle_timeout_valid" CHECK ("browser_sessions"."idle_timeout_seconds" between 60 and 2592000),
	CONSTRAINT "browser_sessions_expiry_valid" CHECK ("browser_sessions"."issued_at" <= "browser_sessions"."last_seen_at"
        and "browser_sessions"."last_seen_at" < "browser_sessions"."idle_expires_at"
        and "browser_sessions"."idle_expires_at" <= "browser_sessions"."absolute_expires_at"),
	CONSTRAINT "browser_sessions_revocation_valid" CHECK ((
        "browser_sessions"."revoked_at" is null and "browser_sessions"."revocation_reason" is null
      ) or (
        "browser_sessions"."revoked_at" is not null and "browser_sessions"."revocation_reason" is not null
        and "browser_sessions"."revoked_at" >= "browser_sessions"."issued_at"
      )),
	CONSTRAINT "browser_sessions_version_positive" CHECK ("browser_sessions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" varchar(2048) NOT NULL,
	"subject" varchar(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_identities_issuer_nonempty" CHECK (char_length("external_identities"."issuer") > 0),
	CONSTRAINT "external_identities_subject_nonempty" CHECK (char_length("external_identities"."subject") > 0),
	CONSTRAINT "external_identities_key_bytes_bounded" CHECK (octet_length("external_identities"."issuer") + octet_length("external_identities"."subject") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "hosted_user_status" DEFAULT 'active' NOT NULL,
	"disabled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_lifecycle_valid" CHECK ((
        ("users"."status" = 'active' and "users"."disabled_at" is null)
        or ("users"."status" = 'disabled' and "users"."disabled_at" is not null)
      )),
	CONSTRAINT "users_timestamps_valid" CHECK ("users"."updated_at" >= "users"."created_at"
        and ("users"."disabled_at" is null or "users"."disabled_at" >= "users"."created_at")),
	CONSTRAINT "users_version_positive" CHECK ("users"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" "workspace_membership_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_pk" PRIMARY KEY("user_id","workspace_id"),
	CONSTRAINT "workspace_memberships_lifecycle_valid" CHECK ((
        ("workspace_memberships"."status" = 'active' and "workspace_memberships"."revoked_at" is null)
        or ("workspace_memberships"."status" = 'revoked' and "workspace_memberships"."revoked_at" is not null)
      )),
	CONSTRAINT "workspace_memberships_timestamps_valid" CHECK ("workspace_memberships"."updated_at" >= "workspace_memberships"."created_at"
        and ("workspace_memberships"."revoked_at" is null or "workspace_memberships"."revoked_at" >= "workspace_memberships"."created_at")),
	CONSTRAINT "workspace_memberships_version_positive" CHECK ("workspace_memberships"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sessions_user_active_idx" ON "browser_sessions" USING btree ("user_id","revoked_at","idle_expires_at","absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_exact_binding_uq" ON "external_identities" USING btree ("issuer" collate "C","subject" collate "C");--> statement-breakpoint
CREATE INDEX "external_identities_user_idx" ON "external_identities" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_workspace_status_idx" ON "workspace_memberships" USING btree ("workspace_id","status","user_id");
