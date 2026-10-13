CREATE TABLE "app"."otp_decoys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" "app"."otp_purpose" NOT NULL,
	"email_key" text NOT NULL,
	"email_masked" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_decoys_attempts_chk" CHECK ("app"."otp_decoys"."attempts" between 0 and 5),
	CONSTRAINT "otp_decoys_purpose_chk" CHECK ("app"."otp_decoys"."purpose" in ('password_reset','deletion')),
	CONSTRAINT "otp_decoys_email_key_chk" CHECK (char_length("app"."otp_decoys"."email_key") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "otp_decoys_active_key" ON "app"."otp_decoys" USING btree ("email_key","purpose") WHERE "app"."otp_decoys"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "otp_decoys_created_at_idx" ON "app"."otp_decoys" USING btree ("created_at");