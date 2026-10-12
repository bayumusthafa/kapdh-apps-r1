CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."message_kind" AS ENUM('text', 'image', 'system');--> statement-breakpoint
CREATE TYPE "app"."report_action" AS ENUM('dismiss', 'warn', 'suspend', 'unsuspend');--> statement-breakpoint
CREATE TYPE "app"."report_category" AS ENUM('spam', 'harassment', 'hate', 'sexual', 'violence_threat', 'scam', 'other');--> statement-breakpoint
CREATE TYPE "app"."report_priority" AS ENUM('normal', 'urgent');--> statement-breakpoint
CREATE TYPE "app"."report_status" AS ENUM('open', 'in_review', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "app"."report_target_type" AS ENUM('user', 'message', 'room');--> statement-breakpoint
CREATE TYPE "app"."room_kind" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "app"."room_member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "app"."room_member_status" AS ENUM('invited', 'joined', 'left', 'removed', 'declined');--> statement-breakpoint
CREATE TYPE "app"."banner_target_type" AS ENUM('none', 'post', 'event', 'page', 'url');--> statement-breakpoint
CREATE TYPE "app"."category_kind" AS ENUM('post', 'event');--> statement-breakpoint
CREATE TYPE "app"."post_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "app"."event_status" AS ENUM('draft', 'open', 'closed', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."ticket_cancelled_by" AS ENUM('self', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "app"."ticket_status" AS ENUM('awaiting_payment', 'awaiting_review', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."account_status" AS ENUM('pending_otp', 'active', 'disabled', 'deletion_pending', 'deleted');--> statement-breakpoint
CREATE TYPE "app"."admin_role" AS ENUM('super_admin', 'admin');--> statement-breakpoint
CREATE TYPE "app"."admin_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "app"."otp_purpose" AS ENUM('signup', 'password_reset', 'deletion', 'email_change');--> statement-breakpoint
CREATE TYPE "app"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "app"."membership_event_kind" AS ENUM('activation', 'renewal', 'suspend', 'unsuspend', 'number_correction', 'warn');--> statement-breakpoint
CREATE TYPE "app"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."device_platform" AS ENUM('android', 'ios');--> statement-breakpoint
CREATE TYPE "app"."notification_category" AS ENUM('payment', 'membership', 'event', 'news', 'chat', 'security', 'account');--> statement-breakpoint
CREATE TYPE "app"."notification_channel" AS ENUM('push', 'email');--> statement-breakpoint
CREATE TYPE "app"."payment_adjustment_kind" AS ENUM('refund', 'correction');--> statement-breakpoint
CREATE TYPE "app"."payment_adjustment_status" AS ENUM('pending', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."payment_event_kind" AS ENUM('created', 'method_changed', 'proof_submitted', 'proof_replaced', 'approved', 'rejected', 'cancelled', 'adjusted');--> statement-breakpoint
CREATE TYPE "app"."payment_method_kind" AS ENUM('bank', 'ewallet');--> statement-breakpoint
CREATE TYPE "app"."payment_status" AS ENUM('pending', 'paid', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."payment_type" AS ENUM('registration', 'renewal', 'ticket');--> statement-breakpoint
CREATE SEQUENCE "app"."membership_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "app"."blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocks_self_chk" CHECK ("app"."blocks"."blocker_id" <> "app"."blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "app"."message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji"),
	CONSTRAINT "message_reactions_emoji_chk" CHECK (char_length("app"."message_reactions"."emoji") between 1 and 16)
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"sender_id" uuid,
	"client_message_id" uuid,
	"kind" "app"."message_kind" NOT NULL,
	"body" text,
	"image_file_id" uuid,
	"reply_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_body_chk" CHECK ("app"."messages"."body" is null or char_length("app"."messages"."body") <= 4000),
	CONSTRAINT "messages_content_chk" CHECK ("app"."messages"."deleted_at" is not null or ("app"."messages"."kind" = 'text' and "app"."messages"."body" is not null and char_length(btrim("app"."messages"."body")) > 0) or ("app"."messages"."kind" = 'image' and "app"."messages"."image_file_id" is not null) or ("app"."messages"."kind" = 'system' and "app"."messages"."body" is not null)),
	CONSTRAINT "messages_client_id_chk" CHECK ("app"."messages"."kind" = 'system' or "app"."messages"."client_message_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid,
	"target_type" "app"."report_target_type" NOT NULL,
	"target_user_id" uuid,
	"target_message_id" uuid,
	"room_id" uuid,
	"category" "app"."report_category" NOT NULL,
	"description" text,
	"evidence" jsonb,
	"priority" "app"."report_priority" DEFAULT 'normal' NOT NULL,
	"status" "app"."report_status" DEFAULT 'open' NOT NULL,
	"action" "app"."report_action",
	"resolution_note" text,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_description_chk" CHECK ("app"."reports"."description" is null or char_length("app"."reports"."description") <= 2000),
	CONSTRAINT "reports_resolved_chk" CHECK ("app"."reports"."status" not in ('resolved','dismissed') or ("app"."reports"."resolved_at" is not null and "app"."reports"."action" is not null)),
	CONSTRAINT "reports_resolution_note_chk" CHECK ("app"."reports"."status" not in ('resolved','dismissed') or ("app"."reports"."resolution_note" is not null and btrim("app"."reports"."resolution_note") <> '')),
	CONSTRAINT "reports_dismissed_chk" CHECK ("app"."reports"."status" <> 'dismissed' or "app"."reports"."action" = 'dismiss')
);
--> statement-breakpoint
CREATE TABLE "app"."room_members" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "app"."room_member_role" DEFAULT 'member' NOT NULL,
	"status" "app"."room_member_status" NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"history_visible_from" timestamp with time zone,
	"last_read_message_id" uuid,
	"last_read_at" timestamp with time zone,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id"),
	CONSTRAINT "room_members_joined_chk" CHECK ("app"."room_members"."status" <> 'joined' or "app"."room_members"."joined_at" is not null),
	CONSTRAINT "room_members_invited_chk" CHECK ("app"."room_members"."status" <> 'invited' or "app"."room_members"."invited_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "app"."room_kind" NOT NULL,
	"direct_key" text,
	"name" text,
	"avatar_file_id" uuid,
	"created_by" uuid,
	"last_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_direct_key_chk" CHECK (("app"."rooms"."kind" = 'direct') = ("app"."rooms"."direct_key" is not null)),
	CONSTRAINT "rooms_direct_key_canonical_chk" CHECK ("app"."rooms"."direct_key" is null or ("app"."rooms"."direct_key" ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$' and split_part("app"."rooms"."direct_key", ':', 1) < split_part("app"."rooms"."direct_key", ':', 2))),
	CONSTRAINT "rooms_name_chk" CHECK ("app"."rooms"."kind" = 'direct' or ("app"."rooms"."name" is not null and char_length(btrim("app"."rooms"."name")) between 1 and 80))
);
--> statement-breakpoint
CREATE TABLE "app"."banners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"image_file_id" uuid NOT NULL,
	"target_type" "app"."banner_target_type" DEFAULT 'none' NOT NULL,
	"target_value" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banners_window_chk" CHECK ("app"."banners"."ends_at" is null or "app"."banners"."ends_at" > "app"."banners"."starts_at"),
	CONSTRAINT "banners_target_chk" CHECK (("app"."banners"."target_type" = 'none') = ("app"."banners"."target_value" is null)),
	CONSTRAINT "banners_url_chk" CHECK ("app"."banners"."target_type" <> 'url' or "app"."banners"."target_value" ~ '^https://'),
	CONSTRAINT "banners_title_chk" CHECK (char_length(btrim("app"."banners"."title")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "app"."categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "app"."category_kind" NOT NULL,
	"label" text NOT NULL,
	"slug" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_slug_chk" CHECK ("app"."categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "categories_label_chk" CHECK (char_length(btrim("app"."categories"."label")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "app"."pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body_html" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_title" text,
	"published_body_html" text,
	"published_version" integer,
	"published_at" timestamp with time zone,
	"updated_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_slug_chk" CHECK ("app"."pages"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "pages_title_chk" CHECK (char_length(btrim("app"."pages"."title")) between 1 and 200),
	CONSTRAINT "pages_published_chk" CHECK (("app"."pages"."published_version" is null and "app"."pages"."published_at" is null and "app"."pages"."published_title" is null and "app"."pages"."published_body_html" is null) or ("app"."pages"."published_version" >= 1 and "app"."pages"."published_at" is not null and "app"."pages"."published_title" is not null and char_length(btrim("app"."pages"."published_title")) between 1 and 200 and "app"."pages"."published_body_html" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."post_likes" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_likes_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"body_html" text NOT NULL,
	"cover_file_id" uuid,
	"category_id" uuid,
	"status" "app"."post_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"announced_at" timestamp with time zone,
	"like_count" integer DEFAULT 0 NOT NULL,
	"author_admin_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_slug_chk" CHECK ("app"."posts"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "posts_title_chk" CHECK (char_length(btrim("app"."posts"."title")) between 1 and 200),
	CONSTRAINT "posts_like_count_chk" CHECK ("app"."posts"."like_count" >= 0),
	CONSTRAINT "posts_published_chk" CHECK ("app"."posts"."status" <> 'published' or "app"."posts"."published_at" is not null),
	CONSTRAINT "posts_announced_chk" CHECK ("app"."posts"."announced_at" is null or "app"."posts"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"location_name" text,
	"location_address" text,
	"location_url" text,
	"cover_file_id" uuid,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"registration_opens_at" timestamp with time zone NOT NULL,
	"registration_closes_at" timestamp with time zone NOT NULL,
	"checkin_opens_at" timestamp with time zone,
	"checkin_closes_at" timestamp with time zone,
	"price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"seats_total" integer NOT NULL,
	"held_quantity" integer DEFAULT 0 NOT NULL,
	"paid_quantity" integer DEFAULT 0 NOT NULL,
	"status" "app"."event_status" DEFAULT 'draft' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by_admin_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_title_chk" CHECK (char_length(btrim("app"."events"."title")) between 1 and 200),
	CONSTRAINT "events_time_chk" CHECK ("app"."events"."ends_at" > "app"."events"."starts_at"),
	CONSTRAINT "events_registration_chk" CHECK ("app"."events"."registration_closes_at" > "app"."events"."registration_opens_at" and "app"."events"."registration_closes_at" <= "app"."events"."ends_at"),
	CONSTRAINT "events_checkin_chk" CHECK (("app"."events"."checkin_opens_at" is null and "app"."events"."checkin_closes_at" is null) or ("app"."events"."checkin_opens_at" is not null and "app"."events"."checkin_closes_at" > "app"."events"."checkin_opens_at")),
	CONSTRAINT "events_price_chk" CHECK ("app"."events"."price" >= 0),
	CONSTRAINT "events_seats_total_chk" CHECK ("app"."events"."seats_total" > 0),
	CONSTRAINT "events_held_quantity_chk" CHECK ("app"."events"."held_quantity" >= 0),
	CONSTRAINT "events_paid_quantity_chk" CHECK ("app"."events"."paid_quantity" >= 0),
	CONSTRAINT "events_capacity_chk" CHECK ("app"."events"."held_quantity" + "app"."events"."paid_quantity" <= "app"."events"."seats_total"),
	CONSTRAINT "events_cancelled_chk" CHECK ("app"."events"."status" <> 'cancelled' or "app"."events"."cancelled_at" is not null),
	CONSTRAINT "events_location_url_chk" CHECK ("app"."events"."location_url" is null or "app"."events"."location_url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "app"."tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"status" "app"."ticket_status" NOT NULL,
	"total_snapshot" numeric(14, 2) NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"qr_code" text,
	"checked_in_at" timestamp with time zone,
	"checked_in_by_admin_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" "app"."ticket_cancelled_by",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_total_snapshot_chk" CHECK ("app"."tickets"."total_snapshot" >= 0),
	CONSTRAINT "tickets_hold_chk" CHECK ("app"."tickets"."status" <> 'awaiting_payment' or "app"."tickets"."hold_expires_at" is not null),
	CONSTRAINT "tickets_paid_qr_chk" CHECK ("app"."tickets"."status" <> 'paid' or "app"."tickets"."qr_code" is not null),
	CONSTRAINT "tickets_checked_in_chk" CHECK ("app"."tickets"."checked_in_at" is null or "app"."tickets"."qr_code" is not null),
	CONSTRAINT "tickets_cancelled_chk" CHECK ("app"."tickets"."status" <> 'cancelled' or ("app"."tickets"."cancelled_at" is not null and "app"."tickets"."cancelled_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."admin_permissions" (
	"admin_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_permissions_admin_id_permission_pk" PRIMARY KEY("admin_id","permission"),
	CONSTRAINT "admin_permissions_permission_chk" CHECK ("app"."admin_permissions"."permission" in ('payments.read','payments.decide','members.read','members.manage','content.manage','master.manage','events.manage','events.checkin','moderation.read','moderation.resolve','audit.read','audit.export','settings.manage','admins.manage','notifications.manage'))
);
--> statement-breakpoint
CREATE TABLE "app"."admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_alumni_user_id" uuid,
	"display_name" text NOT NULL,
	"role" "app"."admin_role" DEFAULT 'admin' NOT NULL,
	"status" "app"."admin_status" DEFAULT 'invited' NOT NULL,
	"invite_token_hash" text,
	"invite_expires_at" timestamp with time zone,
	"invited_by_admin_id" uuid,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"permissions_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_active_chk" CHECK ("app"."admins"."status" <> 'active' or "app"."admins"."activated_at" is not null),
	CONSTRAINT "admins_invite_chk" CHECK (("app"."admins"."invite_token_hash" is null) = ("app"."admins"."invite_expires_at" is null) and ("app"."admins"."invite_token_hash" is null or "app"."admins"."status" = 'invited')),
	CONSTRAINT "admins_disabled_chk" CHECK ("app"."admins"."status" <> 'disabled' or "app"."admins"."disabled_at" is not null),
	CONSTRAINT "admins_display_name_chk" CHECK (char_length(btrim("app"."admins"."display_name")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "app"."mfa_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_encrypted" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_used_step" bigint,
	"backup_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mfa_totp_backup_codes_chk" CHECK (jsonb_typeof("app"."mfa_totp"."backup_code_hashes") = 'array'),
	CONSTRAINT "mfa_totp_last_used_step_chk" CHECK ("app"."mfa_totp"."last_used_step" is null or "app"."mfa_totp"."last_used_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."otp_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "app"."otp_purpose" NOT NULL,
	"code_hmac" text NOT NULL,
	"binding" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_available_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_codes_attempts_chk" CHECK ("app"."otp_codes"."attempts" between 0 and 5)
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
	"app_version" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reauthenticated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_audience_chk" CHECK ("app"."sessions"."audience" in ('mobile','admin')),
	CONSTRAINT "sessions_platform_chk" CHECK ("app"."sessions"."platform" is null or "app"."sessions"."platform" in ('android','ios','web')),
	CONSTRAINT "sessions_mfa_level_chk" CHECK ("app"."sessions"."mfa_level" in (1,2))
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
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_kind_chk" CHECK ("app"."users"."kind" in ('alumni','admin')),
	CONSTRAINT "users_email_normalized_chk" CHECK ("app"."users"."email" = lower(btrim("app"."users"."email"))),
	CONSTRAINT "users_session_version_chk" CHECK ("app"."users"."session_version" >= 1)
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
	"bio" text,
	"last_education_institution" text,
	"last_education_city" text,
	"social_instagram" text,
	"social_x" text,
	"social_facebook" text,
	"social_linkedin" text,
	"show_email" boolean DEFAULT false NOT NULL,
	"show_phone" boolean DEFAULT false NOT NULL,
	"show_social" boolean DEFAULT false NOT NULL,
	"show_in_directory" boolean DEFAULT true NOT NULL,
	"avatar_file_id" uuid,
	"member_seq" bigint,
	"member_number" text,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"suspension_reason" text,
	"suspension_message" text,
	"suspended_by_admin_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_class_chk" CHECK ("app"."alumni"."class_in" between 1 and 6 and "app"."alumni"."class_out" between 1 and 6 and "app"."alumni"."class_out" >= "app"."alumni"."class_in"),
	CONSTRAINT "alumni_cohort_chk" CHECK ("app"."alumni"."cohort" between 1 and 99),
	CONSTRAINT "alumni_full_name_chk" CHECK (char_length(btrim("app"."alumni"."full_name")) between 1 and 120),
	CONSTRAINT "alumni_bio_chk" CHECK ("app"."alumni"."bio" is null or char_length("app"."alumni"."bio") <= 500),
	CONSTRAINT "alumni_member_number_chk" CHECK (("app"."alumni"."member_seq" is null and "app"."alumni"."member_number" is null) or ("app"."alumni"."member_seq" >= 1 and "app"."alumni"."member_number" = lpad("app"."alumni"."cohort"::text, 2, '0') || '.' || (case when "app"."alumni"."class_in" <= 3 and "app"."alumni"."class_out" = 6 then '01' when ("app"."alumni"."class_in" <= 3 and "app"."alumni"."class_out" >= 3) or "app"."alumni"."class_out" = 6 then '02' else '03' end) || '.' || (case when "app"."alumni"."gender" = 'male' then '01' else '02' end) || '.' || "app"."alumni"."member_seq"::text)),
	CONSTRAINT "alumni_period_chk" CHECK (("app"."alumni"."starts_at" is null) = ("app"."alumni"."expires_at" is null) and ("app"."alumni"."expires_at" is null or "app"."alumni"."expires_at" > "app"."alumni"."starts_at"))
);
--> statement-breakpoint
CREATE TABLE "app"."alumni_professions" (
	"alumni_user_id" uuid NOT NULL,
	"profession_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_professions_alumni_user_id_profession_id_pk" PRIMARY KEY("alumni_user_id","profession_id")
);
--> statement-breakpoint
CREATE TABLE "app"."alumni_skills" (
	"alumni_user_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_skills_alumni_user_id_skill_id_pk" PRIMARY KEY("alumni_user_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "app"."master_professions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_professions_label_chk" CHECK ("app"."master_professions"."label" = btrim("app"."master_professions"."label") and char_length("app"."master_professions"."label") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "app"."master_skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_skills_label_chk" CHECK ("app"."master_skills"."label" = btrim("app"."master_skills"."label") and char_length("app"."master_skills"."label") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "app"."membership_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"kind" "app"."membership_event_kind" NOT NULL,
	"payment_id" uuid,
	"actor_admin_id" uuid,
	"reason" text,
	"before_starts_at" timestamp with time zone,
	"after_starts_at" timestamp with time zone,
	"before_expires_at" timestamp with time zone,
	"after_expires_at" timestamp with time zone,
	"before_member_number" text,
	"after_member_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_events_payment_chk" CHECK ("app"."membership_events"."payment_id" is null or "app"."membership_events"."kind" in ('activation','renewal')),
	CONSTRAINT "membership_events_period_chk" CHECK ("app"."membership_events"."kind" not in ('activation','renewal') or ("app"."membership_events"."after_starts_at" is not null and "app"."membership_events"."after_expires_at" > "app"."membership_events"."after_starts_at")),
	CONSTRAINT "membership_events_correction_chk" CHECK ("app"."membership_events"."kind" <> 'number_correction' or ("app"."membership_events"."before_member_number" is not null and "app"."membership_events"."after_member_number" is not null)),
	CONSTRAINT "membership_events_warn_chk" CHECK ("app"."membership_events"."kind" <> 'warn' or ("app"."membership_events"."after_starts_at" is null and "app"."membership_events"."after_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."device_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"platform" "app"."device_platform" NOT NULL,
	"token" text NOT NULL,
	"app_version" text,
	"failure_class" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_failure_count_chk" CHECK ("app"."device_tokens"."failure_count" >= 0),
	CONSTRAINT "device_tokens_token_chk" CHECK (char_length("app"."device_tokens"."token") between 1 and 4096)
);
--> statement-breakpoint
CREATE TABLE "app"."notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "app"."notification_channel" NOT NULL,
	"device_token_id" uuid,
	"status" "app"."delivery_status" DEFAULT 'pending' NOT NULL,
	"provider_status" text,
	"provider_message_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"error_class" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_target_key" UNIQUE NULLS NOT DISTINCT("notification_id","channel","device_token_id"),
	CONSTRAINT "notification_deliveries_channel_chk" CHECK (("app"."notification_deliveries"."channel" = 'push') = ("app"."notification_deliveries"."device_token_id" is not null)),
	CONSTRAINT "notification_deliveries_attempt_chk" CHECK ("app"."notification_deliveries"."attempt" >= 0),
	CONSTRAINT "notification_deliveries_sent_chk" CHECK ("app"."notification_deliveries"."status" <> 'sent' or "app"."notification_deliveries"."sent_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."notification_preferences" (
	"user_id" uuid NOT NULL,
	"category" "app"."notification_category" NOT NULL,
	"channel" "app"."notification_channel" NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_category_channel_pk" PRIMARY KEY("user_id","category","channel"),
	CONSTRAINT "notification_preferences_category_chk" CHECK (("app"."notification_preferences"."channel" = 'push' and "app"."notification_preferences"."category" in ('payment','membership','event','news','chat')) or ("app"."notification_preferences"."channel" = 'email' and "app"."notification_preferences"."category" in ('payment','membership','event')))
);
--> statement-breakpoint
CREATE TABLE "app"."notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "app"."notification_category" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_data_chk" CHECK (jsonb_typeof("app"."notifications"."data") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app"."payment_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "app"."payment_adjustment_kind" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"status" "app"."payment_adjustment_status" DEFAULT 'pending' NOT NULL,
	"refund_destination" jsonb,
	"evidence_file_id" uuid,
	"created_by_admin_id" uuid,
	"completed_by_admin_id" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_adjustments_amount_chk" CHECK ("app"."payment_adjustments"."amount" >= 0),
	CONSTRAINT "payment_adjustments_reason_chk" CHECK (btrim("app"."payment_adjustments"."reason") <> ''),
	CONSTRAINT "payment_adjustments_destination_chk" CHECK ("app"."payment_adjustments"."refund_destination" is null or ("app"."payment_adjustments"."kind" = 'refund' and "app"."payment_adjustments"."status" = 'pending')),
	CONSTRAINT "payment_adjustments_completed_chk" CHECK ("app"."payment_adjustments"."status" <> 'completed' or "app"."payment_adjustments"."completed_at" is not null),
	CONSTRAINT "payment_adjustments_cancelled_chk" CHECK ("app"."payment_adjustments"."status" <> 'cancelled' or "app"."payment_adjustments"."cancelled_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "app"."payment_event_kind" NOT NULL,
	"proof_version" integer,
	"proof_file_id" uuid,
	"actor_user_id" uuid,
	"actor_admin_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_proof_chk" CHECK ("app"."payment_events"."kind" not in ('proof_submitted','proof_replaced') or ("app"."payment_events"."proof_version" >= 1 and "app"."payment_events"."proof_file_id" is not null)),
	CONSTRAINT "payment_events_rejected_chk" CHECK ("app"."payment_events"."kind" <> 'rejected' or ("app"."payment_events"."reason" is not null and btrim("app"."payment_events"."reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "app"."payment_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "app"."payment_method_kind" NOT NULL,
	"provider" text NOT NULL,
	"account_number" text NOT NULL,
	"account_holder" text NOT NULL,
	"instructions" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_provider_chk" CHECK (char_length(btrim("app"."payment_methods"."provider")) between 1 and 80),
	CONSTRAINT "payment_methods_account_number_chk" CHECK (char_length(btrim("app"."payment_methods"."account_number")) between 1 and 64),
	CONSTRAINT "payment_methods_account_holder_chk" CHECK (char_length(btrim("app"."payment_methods"."account_holder")) between 1 and 120)
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
	"settings_version" integer,
	"payment_method_id" uuid,
	"ticket_id" uuid,
	"proof_file_id" uuid,
	"proof_version" integer DEFAULT 0 NOT NULL,
	"transfer_note" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_admin_id" uuid,
	"rejection_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_chk" CHECK ("app"."payments"."amount" >= 0),
	CONSTRAINT "payments_proof_version_chk" CHECK ("app"."payments"."proof_version" >= 0),
	CONSTRAINT "payments_ticket_chk" CHECK (("app"."payments"."type" = 'ticket') = ("app"."payments"."ticket_id" is not null)),
	CONSTRAINT "payments_settings_version_chk" CHECK ("app"."payments"."type" = 'ticket' or "app"."payments"."settings_version" is not null),
	CONSTRAINT "payments_paid_chk" CHECK ("app"."payments"."status" <> 'paid' or ("app"."payments"."proof_version" >= 1 and "app"."payments"."decided_at" is not null)),
	CONSTRAINT "payments_rejected_chk" CHECK ("app"."payments"."status" <> 'rejected' or ("app"."payments"."decided_at" is not null and "app"."payments"."rejection_reason" is not null and btrim("app"."payments"."rejection_reason") <> '')),
	CONSTRAINT "payments_cancelled_chk" CHECK ("app"."payments"."status" <> 'cancelled' or "app"."payments"."cancelled_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."account_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_number" text NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"steps_done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"ledger" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletions_source_chk" CHECK ("app"."account_deletions"."source" in ('app','web')),
	CONSTRAINT "account_deletions_status_chk" CHECK ("app"."account_deletions"."status" in ('pending','processing','completed','failed')),
	CONSTRAINT "account_deletions_request_number_chk" CHECK ("app"."account_deletions"."request_number" ~ '^DEL-[0-9]{4}-[0-9A-Z]{4,}$'),
	CONSTRAINT "account_deletions_deadline_chk" CHECK ("app"."account_deletions"."deadline_at" > "app"."account_deletions"."requested_at"),
	CONSTRAINT "account_deletions_completed_chk" CHECK ("app"."account_deletions"."status" <> 'completed' or "app"."account_deletions"."completed_at" is not null),
	CONSTRAINT "account_deletions_steps_chk" CHECK (jsonb_typeof("app"."account_deletions"."steps_done") = 'array'),
	CONSTRAINT "account_deletions_ledger_chk" CHECK (jsonb_typeof("app"."account_deletions"."ledger") = 'object'),
	CONSTRAINT "account_deletions_attempts_chk" CHECK ("app"."account_deletions"."attempts" >= 0)
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_effective_role_chk" CHECK ("app"."audit_logs"."effective_role" in ('alumni','admin','super_admin','system','anonymous'))
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
	"status" text DEFAULT 'pending' NOT NULL,
	"width" integer,
	"height" integer,
	"attached_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_purpose_chk" CHECK ("app"."files"."purpose" in ('avatar','chat_image','post_cover','banner_image','event_cover','payment_proof','adjustment_evidence','audit_export')),
	CONSTRAINT "files_storage_driver_chk" CHECK ("app"."files"."storage_driver" in ('local','s3')),
	CONSTRAINT "files_visibility_chk" CHECK ("app"."files"."visibility" in ('private','public')),
	CONSTRAINT "files_status_chk" CHECK ("app"."files"."status" in ('pending','ready','failed','deleted')),
	CONSTRAINT "files_bytes_chk" CHECK ("app"."files"."bytes" >= 0),
	CONSTRAINT "files_dimensions_chk" CHECK (("app"."files"."width" is null or "app"."files"."width" > 0) and ("app"."files"."height" is null or "app"."files"."height" > 0)),
	CONSTRAINT "files_deleted_chk" CHECK ("app"."files"."status" <> 'deleted' or "app"."files"."deleted_at" is not null),
	CONSTRAINT "files_private_purpose_chk" CHECK ("app"."files"."visibility" = 'private' or "app"."files"."purpose" in ('avatar','post_cover','banner_image','event_cover'))
);
--> statement-breakpoint
CREATE TABLE "app"."idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"endpoint" text NOT NULL,
	"key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_status_chk" CHECK ("app"."idempotency_keys"."status" in ('in_progress','completed')),
	CONSTRAINT "idempotency_keys_completed_chk" CHECK ("app"."idempotency_keys"."status" <> 'completed' or "app"."idempotency_keys"."response_status" is not null),
	CONSTRAINT "idempotency_keys_key_chk" CHECK (char_length("app"."idempotency_keys"."key") between 1 and 255)
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
	"locked_until" timestamp with time zone,
	"last_error" text,
	"request_id" text,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_chk" CHECK ("app"."outbox_events"."status" in ('pending','dispatched','failed','dead')),
	CONSTRAINT "outbox_events_attempts_chk" CHECK ("app"."outbox_events"."attempts" >= 0),
	CONSTRAINT "outbox_events_dispatched_chk" CHECK ("app"."outbox_events"."status" <> 'dispatched' or "app"."outbox_events"."dispatched_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_admin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_chk" CHECK ("app"."app_settings"."key" ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "app_settings_value_chk" CHECK (jsonb_typeof("app"."app_settings"."value") = 'object'),
	CONSTRAINT "app_settings_version_chk" CHECK ("app"."app_settings"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "app"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_target_message_id_messages_id_fk" FOREIGN KEY ("target_message_id") REFERENCES "app"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reports" ADD CONSTRAINT "reports_resolved_by_admin_id_admins_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "app"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."room_members" ADD CONSTRAINT "room_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."room_members" ADD CONSTRAINT "room_members_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "app"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."rooms" ADD CONSTRAINT "rooms_avatar_file_id_files_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."rooms" ADD CONSTRAINT "rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."banners" ADD CONSTRAINT "banners_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "app"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pages" ADD CONSTRAINT "pages_updated_by_admin_id_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."post_likes" ADD CONSTRAINT "post_likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "app"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."post_likes" ADD CONSTRAINT "post_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."posts" ADD CONSTRAINT "posts_cover_file_id_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."posts" ADD CONSTRAINT "posts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "app"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."posts" ADD CONSTRAINT "posts_author_admin_id_admins_id_fk" FOREIGN KEY ("author_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "app"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_cover_file_id_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tickets" ADD CONSTRAINT "tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tickets" ADD CONSTRAINT "tickets_checked_in_by_admin_id_admins_id_fk" FOREIGN KEY ("checked_in_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admin_permissions" ADD CONSTRAINT "admin_permissions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "app"."admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admin_permissions" ADD CONSTRAINT "admin_permissions_granted_by_admin_id_admins_id_fk" FOREIGN KEY ("granted_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admins" ADD CONSTRAINT "admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admins" ADD CONSTRAINT "admins_linked_alumni_user_id_users_id_fk" FOREIGN KEY ("linked_alumni_user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."admins" ADD CONSTRAINT "admins_invited_by_admin_id_admins_id_fk" FOREIGN KEY ("invited_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mfa_totp" ADD CONSTRAINT "mfa_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."otp_codes" ADD CONSTRAINT "otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_replaced_by_sessions_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "app"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni" ADD CONSTRAINT "alumni_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni" ADD CONSTRAINT "alumni_avatar_file_id_files_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni" ADD CONSTRAINT "alumni_suspended_by_admin_id_admins_id_fk" FOREIGN KEY ("suspended_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_professions" ADD CONSTRAINT "alumni_professions_alumni_user_id_alumni_user_id_fk" FOREIGN KEY ("alumni_user_id") REFERENCES "app"."alumni"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_professions" ADD CONSTRAINT "alumni_professions_profession_id_master_professions_id_fk" FOREIGN KEY ("profession_id") REFERENCES "app"."master_professions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_skills" ADD CONSTRAINT "alumni_skills_alumni_user_id_alumni_user_id_fk" FOREIGN KEY ("alumni_user_id") REFERENCES "app"."alumni"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_skills" ADD CONSTRAINT "alumni_skills_skill_id_master_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "app"."master_skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_events" ADD CONSTRAINT "membership_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_events" ADD CONSTRAINT "membership_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_events" ADD CONSTRAINT "membership_events_actor_admin_id_admins_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."device_tokens" ADD CONSTRAINT "device_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "app"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_token_id_device_tokens_id_fk" FOREIGN KEY ("device_token_id") REFERENCES "app"."device_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_evidence_file_id_files_id_fk" FOREIGN KEY ("evidence_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_adjustments" ADD CONSTRAINT "payment_adjustments_completed_by_admin_id_admins_id_fk" FOREIGN KEY ("completed_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "app"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "app"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_proof_file_id_files_id_fk" FOREIGN KEY ("proof_file_id") REFERENCES "app"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."payments" ADD CONSTRAINT "payments_decided_by_admin_id_admins_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."app_settings" ADD CONSTRAINT "app_settings_updated_by_admin_id_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "app"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_id_idx" ON "app"."blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "message_reactions_user_id_idx" ON "app"."message_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_id_client_message_id_key" ON "app"."messages" USING btree ("sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "messages_room_id_created_at_id_idx" ON "app"."messages" USING btree ("room_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "app"."messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "messages_reply_to_id_idx" ON "app"."messages" USING btree ("reply_to_id") WHERE "app"."messages"."reply_to_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_image_file_id_idx" ON "app"."messages" USING btree ("image_file_id") WHERE "app"."messages"."image_file_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_status_created_at_idx" ON "app"."reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_id_idx" ON "app"."reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "reports_target_user_id_idx" ON "app"."reports" USING btree ("target_user_id") WHERE "app"."reports"."target_user_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_target_message_id_idx" ON "app"."reports" USING btree ("target_message_id") WHERE "app"."reports"."target_message_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_room_id_idx" ON "app"."reports" USING btree ("room_id") WHERE "app"."reports"."room_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_resolved_by_admin_id_idx" ON "app"."reports" USING btree ("resolved_by_admin_id") WHERE "app"."reports"."resolved_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "room_members_user_id_status_idx" ON "app"."room_members" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "room_members_room_id_status_idx" ON "app"."room_members" USING btree ("room_id","status");--> statement-breakpoint
CREATE INDEX "room_members_invited_by_idx" ON "app"."room_members" USING btree ("invited_by") WHERE "app"."room_members"."invited_by" is not null;--> statement-breakpoint
CREATE INDEX "room_members_last_read_message_id_idx" ON "app"."room_members" USING btree ("last_read_message_id") WHERE "app"."room_members"."last_read_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_direct_key_key" ON "app"."rooms" USING btree ("direct_key");--> statement-breakpoint
CREATE INDEX "rooms_created_by_idx" ON "app"."rooms" USING btree ("created_by") WHERE "app"."rooms"."created_by" is not null;--> statement-breakpoint
CREATE INDEX "rooms_avatar_file_id_idx" ON "app"."rooms" USING btree ("avatar_file_id") WHERE "app"."rooms"."avatar_file_id" is not null;--> statement-breakpoint
CREATE INDEX "banners_image_file_id_idx" ON "app"."banners" USING btree ("image_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_kind_slug_key" ON "app"."categories" USING btree ("kind","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_key" ON "app"."pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pages_updated_by_admin_id_idx" ON "app"."pages" USING btree ("updated_by_admin_id") WHERE "app"."pages"."updated_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "post_likes_user_id_idx" ON "app"."post_likes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_slug_key" ON "app"."posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "posts_status_published_at_idx" ON "app"."posts" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "posts_category_id_idx" ON "app"."posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "posts_cover_file_id_idx" ON "app"."posts" USING btree ("cover_file_id") WHERE "app"."posts"."cover_file_id" is not null;--> statement-breakpoint
CREATE INDEX "posts_author_admin_id_idx" ON "app"."posts" USING btree ("author_admin_id") WHERE "app"."posts"."author_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "app"."events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_category_id_idx" ON "app"."events" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "events_cover_file_id_idx" ON "app"."events" USING btree ("cover_file_id") WHERE "app"."events"."cover_file_id" is not null;--> statement-breakpoint
CREATE INDEX "events_created_by_admin_id_idx" ON "app"."events" USING btree ("created_by_admin_id") WHERE "app"."events"."created_by_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_user_id_event_id_active_key" ON "app"."tickets" USING btree ("user_id","event_id") WHERE "app"."tickets"."status" in ('awaiting_payment','awaiting_review','paid');--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_qr_code_key" ON "app"."tickets" USING btree ("qr_code");--> statement-breakpoint
CREATE INDEX "tickets_event_id_status_idx" ON "app"."tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "tickets_status_hold_expires_at_idx" ON "app"."tickets" USING btree ("status","hold_expires_at");--> statement-breakpoint
CREATE INDEX "tickets_user_id_created_at_idx" ON "app"."tickets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_checked_in_by_admin_id_idx" ON "app"."tickets" USING btree ("checked_in_by_admin_id") WHERE "app"."tickets"."checked_in_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "admin_permissions_granted_by_admin_id_idx" ON "app"."admin_permissions" USING btree ("granted_by_admin_id") WHERE "app"."admin_permissions"."granted_by_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_user_id_key" ON "app"."admins" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admins_linked_alumni_user_id_key" ON "app"."admins" USING btree ("linked_alumni_user_id") WHERE "app"."admins"."linked_alumni_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_invite_token_hash_key" ON "app"."admins" USING btree ("invite_token_hash") WHERE "app"."admins"."invite_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "admins_invited_by_admin_id_idx" ON "app"."admins" USING btree ("invited_by_admin_id") WHERE "app"."admins"."invited_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "otp_codes_user_id_purpose_idx" ON "app"."otp_codes" USING btree ("user_id","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "otp_codes_active_key" ON "app"."otp_codes" USING btree ("user_id","purpose") WHERE "app"."otp_codes"."consumed_at" is null and "app"."otp_codes"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "otp_codes_expires_at_idx" ON "app"."otp_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_hash_key" ON "app"."sessions" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "app"."sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "app"."sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "app"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_replaced_by_idx" ON "app"."sessions" USING btree ("replaced_by") WHERE "app"."sessions"."replaced_by" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_kind_email_key" ON "app"."users" USING btree ("kind","email") WHERE "app"."users"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_member_seq_key" ON "app"."alumni" USING btree ("member_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_member_number_key" ON "app"."alumni" USING btree ("member_number");--> statement-breakpoint
CREATE INDEX "alumni_cohort_class_idx" ON "app"."alumni" USING btree ("cohort","class_in","class_out");--> statement-breakpoint
CREATE INDEX "alumni_city_idx" ON "app"."alumni" USING btree (lower("city"));--> statement-breakpoint
CREATE INDEX "alumni_full_name_idx" ON "app"."alumni" USING btree (lower("full_name") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "alumni_expires_at_idx" ON "app"."alumni" USING btree ("expires_at") WHERE "app"."alumni"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "alumni_avatar_file_id_idx" ON "app"."alumni" USING btree ("avatar_file_id") WHERE "app"."alumni"."avatar_file_id" is not null;--> statement-breakpoint
CREATE INDEX "alumni_suspended_by_admin_id_idx" ON "app"."alumni" USING btree ("suspended_by_admin_id") WHERE "app"."alumni"."suspended_by_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_professions_alumni_user_id_key" ON "app"."alumni_professions" USING btree ("alumni_user_id");--> statement-breakpoint
CREATE INDEX "alumni_professions_profession_id_idx" ON "app"."alumni_professions" USING btree ("profession_id");--> statement-breakpoint
CREATE INDEX "alumni_skills_skill_id_idx" ON "app"."alumni_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "master_professions_label_key" ON "app"."master_professions" USING btree (lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "master_skills_label_key" ON "app"."master_skills" USING btree (lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "membership_events_payment_id_key" ON "app"."membership_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "membership_events_user_id_created_at_idx" ON "app"."membership_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "membership_events_actor_admin_id_idx" ON "app"."membership_events" USING btree ("actor_admin_id") WHERE "app"."membership_events"."actor_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_key" ON "app"."device_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "device_tokens_user_id_idx" ON "app"."device_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_tokens_session_id_idx" ON "app"."device_tokens" USING btree ("session_id") WHERE "app"."device_tokens"."session_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_next_retry_at_idx" ON "app"."notification_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_device_token_id_idx" ON "app"."notification_deliveries" USING btree ("device_token_id") WHERE "app"."notification_deliveries"."device_token_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedup_key_key" ON "app"."notifications" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "app"."notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_unread_idx" ON "app"."notifications" USING btree ("user_id") WHERE "app"."notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "payment_adjustments_payment_id_idx" ON "app"."payment_adjustments" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_adjustments_status_due_at_idx" ON "app"."payment_adjustments" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "payment_adjustments_evidence_file_id_idx" ON "app"."payment_adjustments" USING btree ("evidence_file_id") WHERE "app"."payment_adjustments"."evidence_file_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_adjustments_created_by_admin_id_idx" ON "app"."payment_adjustments" USING btree ("created_by_admin_id") WHERE "app"."payment_adjustments"."created_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_adjustments_completed_by_admin_id_idx" ON "app"."payment_adjustments" USING btree ("completed_by_admin_id") WHERE "app"."payment_adjustments"."completed_by_admin_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_created_at_idx" ON "app"."payment_events" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_user_id_type_open_key" ON "app"."payments" USING btree ("user_id","type") WHERE "app"."payments"."status" in ('pending','rejected') and "app"."payments"."type" in ('registration','renewal');--> statement-breakpoint
CREATE UNIQUE INDEX "payments_ticket_id_key" ON "app"."payments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "payments_status_submitted_at_idx" ON "app"."payments" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "payments_user_id_created_at_idx" ON "app"."payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_proof_file_id_idx" ON "app"."payments" USING btree ("proof_file_id") WHERE "app"."payments"."proof_file_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_payment_method_id_idx" ON "app"."payments" USING btree ("payment_method_id") WHERE "app"."payments"."payment_method_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_decided_by_admin_id_idx" ON "app"."payments" USING btree ("decided_by_admin_id") WHERE "app"."payments"."decided_by_admin_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_request_number_key" ON "app"."account_deletions" USING btree ("request_number");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletions_user_id_open_key" ON "app"."account_deletions" USING btree ("user_id") WHERE "app"."account_deletions"."status" in ('pending','processing','failed');--> statement-breakpoint
CREATE INDEX "account_deletions_user_id_idx" ON "app"."account_deletions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_deletions_status_next_attempt_at_idx" ON "app"."account_deletions" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "app"."audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_admin_id_created_at_idx" ON "app"."audit_logs" USING btree ("actor_admin_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "app"."audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "files_object_key_key" ON "app"."files" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "files_owner_user_id_purpose_created_at_idx" ON "app"."files" USING btree ("owner_user_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "files_cleanup_idx" ON "app"."files" USING btree ("created_at") WHERE "app"."files"."attached_at" is null and "app"."files"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "files_expires_at_idx" ON "app"."files" USING btree ("expires_at") WHERE "app"."files"."expires_at" is not null and "app"."files"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_endpoint_key_key" ON "app"."idempotency_keys" USING btree ("scope","endpoint","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "app"."idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_dedup_key_key" ON "app"."outbox_events" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "app"."outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "app_settings_updated_by_admin_id_idx" ON "app"."app_settings" USING btree ("updated_by_admin_id") WHERE "app"."app_settings"."updated_by_admin_id" is not null;