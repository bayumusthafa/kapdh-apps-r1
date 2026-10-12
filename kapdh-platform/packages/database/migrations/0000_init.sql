CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."account_status" AS ENUM('pending_otp', 'active', 'disabled', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."admin_role" AS ENUM('super_admin', 'admin');--> statement-breakpoint
CREATE TYPE "app"."otp_purpose" AS ENUM('signup', 'password_reset', 'deletion');--> statement-breakpoint
CREATE TYPE "app"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "app"."payment_status" AS ENUM('pending', 'paid', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."payment_type" AS ENUM('registration', 'renewal', 'ticket');--> statement-breakpoint
CREATE SEQUENCE "app"."membership_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "app"."admin_permissions" (
	"admin_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "admin_permissions_admin_id_permission_pk" PRIMARY KEY("admin_id","permission")
);
--> statement-breakpoint
CREATE TABLE "app"."admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_alumni_user_id" uuid,
	"display_name" text NOT NULL,
	"role" "app"."admin_role" DEFAULT 'admin' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"permissions_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."mfa_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"verified_at" timestamp with time zone,
	"backup_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."otp_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "app"."otp_purpose" NOT NULL,
	"code_hmac" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_attempts_chk" CHECK ("app"."otp_codes"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"audience" text NOT NULL,
	"mfa_level" smallint DEFAULT 1 NOT NULL,
	"device_name" text,
	"platform" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "app"."account_status" DEFAULT 'pending_otp' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"policy_version" text,
	"policy_accepted_at" timestamp with time zone,
	"session_version" integer DEFAULT 1 NOT NULL,
	"kind" text DEFAULT 'alumni' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_kind_chk" CHECK ("app"."users"."kind" in ('alumni','admin'))
);
--> statement-breakpoint
CREATE TABLE "app"."alumni" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"gender" "app"."gender" NOT NULL,
	"cohort" smallint NOT NULL,
	"class_in" smallint NOT NULL,
	"class_out" smallint NOT NULL,
	"city" text,
	"phone" text,
	"profession_id" uuid,
	"avatar_file_id" uuid,
	"member_seq" bigint,
	"member_number" text,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspension_message" text,
	"show_in_directory" boolean DEFAULT true NOT NULL,
	"show_phone" boolean DEFAULT false NOT NULL,
	"show_social" boolean DEFAULT false NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_class_chk" CHECK ("app"."alumni"."class_in" between 1 and 6 and "app"."alumni"."class_out" between 1 and 6 and "app"."alumni"."class_out" >= "app"."alumni"."class_in"),
	CONSTRAINT "alumni_cohort_chk" CHECK ("app"."alumni"."cohort" between 1 and 99)
);
--> statement-breakpoint
CREATE TABLE "app"."membership_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"before_expires_at" timestamp with time zone,
	"after_expires_at" timestamp with time zone,
	"before_number" text,
	"after_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."fee_settings" (
	"version" integer PRIMARY KEY NOT NULL,
	"registration_fee" numeric(14, 2) NOT NULL,
	"card_fee" numeric(14, 2) NOT NULL,
	"renewal_fee" numeric(14, 2) NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"proof_version" integer,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder" text NOT NULL,
	"instructions" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"type" "app"."payment_type" NOT NULL,
	"status" "app"."payment_status" DEFAULT 'pending' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"lines_snapshot" jsonb NOT NULL,
	"method_snapshot" jsonb NOT NULL,
	"fee_settings_version" integer NOT NULL,
	"ticket_id" uuid,
	"proof_file_id" uuid,
	"proof_version" integer DEFAULT 0 NOT NULL,
	"transfer_note" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_admin_id" uuid,
	"rejection_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_chk" CHECK ("app"."payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"effective_role" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"request_id" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid,
	"purpose" text NOT NULL,
	"storage_driver" text NOT NULL,
	"object_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"attached_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."idempotency_keys" (
	"actor_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"key" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."admin_permissions" ADD CONSTRAINT "admin_permissions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "app"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admins" ADD CONSTRAINT "admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admins" ADD CONSTRAINT "admins_linked_alumni_user_id_users_id_fk" FOREIGN KEY ("linked_alumni_user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mfa_totp" ADD CONSTRAINT "mfa_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni" ADD CONSTRAINT "alumni_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_events" ADD CONSTRAINT "membership_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_user_key" ON "app"."admins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "otp_codes_user_purpose_idx" ON "app"."otp_codes" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "app"."sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "app"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "app"."sessions" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "app"."users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_member_seq_key" ON "app"."alumni" USING btree ("member_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_member_number_key" ON "app"."alumni" USING btree ("member_number");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_events_payment_key" ON "app"."membership_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "membership_events_user_idx" ON "app"."membership_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "app"."payment_events" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_open_per_type_key" ON "app"."payments" USING btree ("user_id","type") WHERE "app"."payments"."status" in ('pending','rejected') and "app"."payments"."type" in ('registration','renewal');--> statement-breakpoint
CREATE INDEX "payments_queue_idx" ON "app"."payments" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "app"."audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "files_object_key" ON "app"."files" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "app"."files" USING btree ("owner_user_id","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key" ON "app"."idempotency_keys" USING btree ("actor_id","endpoint","key");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedup_key" ON "app"."outbox_events" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "app"."outbox_events" USING btree ("status","next_attempt_at");