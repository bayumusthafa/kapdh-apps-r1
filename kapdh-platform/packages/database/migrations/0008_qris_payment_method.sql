ALTER TYPE "app"."payment_method_kind" ADD VALUE 'qris';--> statement-breakpoint
ALTER TABLE "app"."files" DROP CONSTRAINT "files_purpose_chk";--> statement-breakpoint
ALTER TABLE "app"."files" DROP CONSTRAINT "files_private_purpose_chk";--> statement-breakpoint
ALTER TABLE "app"."payment_methods" ADD COLUMN "qr_image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."payment_methods" ADD CONSTRAINT "payment_methods_qr_image_file_id_files_id_fk" FOREIGN KEY ("qr_image_file_id") REFERENCES "app"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_methods_qr_image_file_id_idx" ON "app"."payment_methods" USING btree ("qr_image_file_id") WHERE "app"."payment_methods"."qr_image_file_id" is not null;--> statement-breakpoint
ALTER TABLE "app"."payment_methods" ADD CONSTRAINT "payment_methods_qr_image_chk" CHECK (("app"."payment_methods"."kind"::text = 'qris') = ("app"."payment_methods"."qr_image_file_id" is not null));--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_purpose_chk" CHECK ("app"."files"."purpose" in ('avatar','chat_image','post_cover','banner_image','event_cover','payment_proof','adjustment_evidence','audit_export','payment_qr'));--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_private_purpose_chk" CHECK ("app"."files"."visibility" = 'private' or "app"."files"."purpose" in ('avatar','post_cover','banner_image','event_cover','payment_qr'));