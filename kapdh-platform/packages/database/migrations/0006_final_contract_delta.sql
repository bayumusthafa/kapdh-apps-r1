ALTER TYPE "app"."report_category" ADD VALUE 'appeal';--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" DROP CONSTRAINT "payment_adjustments_cancelled_chk";--> statement-breakpoint
ALTER TABLE "app"."reports" ALTER COLUMN "due_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD COLUMN "claimed_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD COLUMN "member_message" text;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD COLUMN "message_removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD COLUMN "cancelled_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_claimed_by_admin_id_admins_id_fk" FOREIGN KEY ("claimed_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_cancelled_by_admin_id_admins_id_fk" FOREIGN KEY ("cancelled_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_claimed_by_admin_id_idx" ON "app"."reports" USING btree ("claimed_by_admin_id") WHERE "app"."reports"."claimed_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_adjustments_cancelled_by_admin_id_idx" ON "app"."payment_adjustments" USING btree ("cancelled_by_admin_id") WHERE "app"."payment_adjustments"."cancelled_by_admin_id" is not null;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_member_message_chk" CHECK ("app"."reports"."member_message" is null or char_length("app"."reports"."member_message") <= 500);--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_claimed_chk" CHECK ("app"."reports"."status" <> 'in_review' or "app"."reports"."claimed_at" is not null);--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_cancelled_chk" CHECK ("app"."payment_adjustments"."status" <> 'cancelled' or ("app"."payment_adjustments"."cancelled_at" is not null and "app"."payment_adjustments"."cancel_reason" is not null and btrim("app"."payment_adjustments"."cancel_reason") <> ''));