ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_email_unique'
    ) THEN
        ALTER TABLE "user" ADD CONSTRAINT "user_email_unique" UNIQUE("email");
    END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_otp" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" integer NOT NULL,
    "code_hash" text NOT NULL,
    "expires_at" timestamp NOT NULL,
    "consumed_at" timestamp,
    "attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'login_otp_user_id_user_id_fk'
    ) THEN
        ALTER TABLE "login_otp"
            ADD CONSTRAINT "login_otp_user_id_user_id_fk"
            FOREIGN KEY ("user_id") REFERENCES "public"."user"("id")
            ON DELETE cascade
            ON UPDATE no action;
    END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otp_user_id_idx" ON "login_otp" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otp_user_pending_idx" ON "login_otp" USING btree ("user_id","consumed_at","expires_at");
