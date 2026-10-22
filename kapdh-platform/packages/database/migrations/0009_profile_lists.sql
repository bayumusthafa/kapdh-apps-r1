-- Batas tunggu kunci di bawah. Selama permintaan EXCLUSIVE mengantre, semua tulisan profil baru ikut tertahan di
-- belakangnya; tanpa batas, satu transaksi lama yang menggantung menahan simpan profil tanpa akhir. Bila kunci tidak
-- diperoleh dalam 15 detik, job gagal dengan 55P03 (lock_not_available): seluruh transaksi migrasi dibatalkan, skema
-- tetap seperti sebelum 0009, dan job rilis dapat diulang. SET LOCAL hanya berlaku di transaksi job migrasi.
SET LOCAL lock_timeout = '15s';--> statement-breakpoint
-- Kunci lebih dahulu: API/worker lama tetap berjalan selama job rilis. Tanpa kunci ini, transaksi lama yang memegang
-- baris alumni FOR UPDATE dan menunggu kunci tabel dari ADD FOREIGN KEY di bawah dapat deadlock dengan cek FK backfill
-- 0010 (40P01). EXCLUSIVE menunggu transaksi yang sedang berjalan selesai lalu menahan tulisan baru sampai job commit;
-- SELECT biasa tetap berjalan.
LOCK TABLE "app"."alumni", "app"."alumni_professions", "app"."master_professions" IN EXCLUSIVE MODE;--> statement-breakpoint
-- Kunci sudah dipegang sampai commit; batas tunggu kembali ke nilai bawaan agar tidak membatasi migrasi berikutnya yang
-- diterapkan dalam transaksi yang sama. Statement 0009-0010 berikutnya hanya menyentuh tabel yang sudah dikunci atau
-- tabel baru, jadi tidak menunggu kunci lain.
SET LOCAL lock_timeout TO DEFAULT;--> statement-breakpoint
CREATE TABLE "app"."alumni_education" (
	"alumni_user_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"institution" text NOT NULL,
	"major" text,
	"level" text,
	"graduation_year" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_education_alumni_user_id_position_pk" PRIMARY KEY("alumni_user_id","position"),
	CONSTRAINT "alumni_education_institution_chk" CHECK ("app"."alumni_education"."institution" = btrim("app"."alumni_education"."institution") and char_length("app"."alumni_education"."institution") between 1 and 120),
	CONSTRAINT "alumni_education_major_chk" CHECK ("app"."alumni_education"."major" is null or ("app"."alumni_education"."major" = btrim("app"."alumni_education"."major") and char_length("app"."alumni_education"."major") between 1 and 120)),
	CONSTRAINT "alumni_education_level_chk" CHECK ("app"."alumni_education"."level" is null or "app"."alumni_education"."level" in ('d3','s1','s2','s3','other')),
	CONSTRAINT "alumni_education_year_chk" CHECK ("app"."alumni_education"."graduation_year" is null or "app"."alumni_education"."graduation_year" between 1950 and 2100)
);
--> statement-breakpoint
CREATE TABLE "app"."alumni_profession_entries" (
	"alumni_user_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"profession_id" uuid,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_profession_entries_alumni_user_id_position_pk" PRIMARY KEY("alumni_user_id","position"),
	CONSTRAINT "alumni_profession_entries_source_chk" CHECK (("app"."alumni_profession_entries"."profession_id" is null) <> ("app"."alumni_profession_entries"."label" is null)),
	CONSTRAINT "alumni_profession_entries_label_chk" CHECK ("app"."alumni_profession_entries"."label" is null or ("app"."alumni_profession_entries"."label" = btrim("app"."alumni_profession_entries"."label") and char_length("app"."alumni_profession_entries"."label") between 1 and 100))
);
--> statement-breakpoint
CREATE TABLE "app"."alumni_social_links" (
	"alumni_user_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"platform" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_social_links_alumni_user_id_position_pk" PRIMARY KEY("alumni_user_id","position"),
	CONSTRAINT "alumni_social_links_platform_chk" CHECK ("app"."alumni_social_links"."platform" in ('instagram','tiktok','x','facebook','linkedin','youtube','threads','telegram','website')),
	CONSTRAINT "alumni_social_links_value_chk" CHECK (char_length("app"."alumni_social_links"."value") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "app"."alumni_education" ADD CONSTRAINT "alumni_education_alumni_user_id_alumni_user_id_fk" FOREIGN KEY ("alumni_user_id") REFERENCES "app"."alumni"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_profession_entries" ADD CONSTRAINT "alumni_profession_entries_alumni_user_id_alumni_user_id_fk" FOREIGN KEY ("alumni_user_id") REFERENCES "app"."alumni"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_profession_entries" ADD CONSTRAINT "alumni_profession_entries_profession_id_fk" FOREIGN KEY ("profession_id") REFERENCES "app"."master_professions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alumni_social_links" ADD CONSTRAINT "alumni_social_links_alumni_user_id_alumni_user_id_fk" FOREIGN KEY ("alumni_user_id") REFERENCES "app"."alumni"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_profession_entries_profession_key" ON "app"."alumni_profession_entries" USING btree ("alumni_user_id","profession_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_profession_entries_label_key" ON "app"."alumni_profession_entries" USING btree ("alumni_user_id",lower("label")) WHERE "app"."alumni_profession_entries"."label" is not null;--> statement-breakpoint
CREATE INDEX "alumni_profession_entries_profession_id_idx" ON "app"."alumni_profession_entries" USING btree ("profession_id") WHERE "app"."alumni_profession_entries"."profession_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_social_links_value_key" ON "app"."alumni_social_links" USING btree ("alumni_user_id","platform",lower("value"));