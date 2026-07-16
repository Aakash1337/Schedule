CREATE TABLE "hosted_login_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state_digest" varchar(64) NOT NULL,
	"browser_binding_digest" varchar(64) NOT NULL,
	"issuer" varchar(2048) NOT NULL,
	"client_id" varchar(512) NOT NULL,
	"redirect_uri" varchar(2048) NOT NULL,
	"return_to_path" varchar(2048) NOT NULL,
	"nonce" varchar(43) NOT NULL,
	"pkce_challenge" varchar(43) NOT NULL,
	"pkce_method" varchar(4) DEFAULT 'S256' NOT NULL,
	"protected_pkce_verifier" varchar(2048) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "hosted_login_transactions_state_digest_uq" UNIQUE("state_digest"),
	CONSTRAINT "hosted_login_transactions_browser_binding_digest_uq" UNIQUE("browser_binding_digest"),
	CONSTRAINT "hosted_login_transactions_digests_valid" CHECK ("hosted_login_transactions"."state_digest" ~ '^[0-9a-f]{64}$'
        and "hosted_login_transactions"."browser_binding_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hosted_login_transactions_oidc_values_valid" CHECK (char_length("hosted_login_transactions"."issuer") > 0
        and char_length("hosted_login_transactions"."client_id") > 0
        and char_length("hosted_login_transactions"."redirect_uri") > 0
        and char_length("hosted_login_transactions"."return_to_path") > 0
        and "hosted_login_transactions"."nonce" ~ '^[A-Za-z0-9_-]{43}$'
        and "hosted_login_transactions"."pkce_challenge" ~ '^[A-Za-z0-9_-]{43}$'
        and "hosted_login_transactions"."pkce_method" = 'S256'
        and char_length("hosted_login_transactions"."protected_pkce_verifier") > 0),
	CONSTRAINT "hosted_login_transactions_lifecycle_valid" CHECK ("hosted_login_transactions"."expires_at" >= "hosted_login_transactions"."created_at" + interval '60 seconds'
        and "hosted_login_transactions"."expires_at" <= "hosted_login_transactions"."created_at" + interval '15 minutes'
        and ("hosted_login_transactions"."consumed_at" is null or (
          "hosted_login_transactions"."consumed_at" >= "hosted_login_transactions"."created_at"
          and "hosted_login_transactions"."consumed_at" < "hosted_login_transactions"."expires_at"
        ))),
	CONSTRAINT "hosted_login_transactions_version_positive" CHECK ("hosted_login_transactions"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX "hosted_login_transactions_expiry_idx" ON "hosted_login_transactions" USING btree ("expires_at","id");
