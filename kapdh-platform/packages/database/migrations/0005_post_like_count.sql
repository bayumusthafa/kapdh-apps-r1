-- posts.like_count selalu sama dengan jumlah baris post_likes (AC F08-3 "penghitung tetap konsisten", PRD 6.2
-- post_likes). Penghitung dipelihara di database pada setiap INSERT/DELETE post_likes, termasuk penghapusan kaskade
-- saat akun dihapus (F-14) yang tidak melewati layanan konten. Layanan cukup INSERT ... ON CONFLICT DO NOTHING /
-- DELETE pada post_likes (like idempoten) dan tidak boleh mengubah like_count sendiri.
-- Trigger statement dengan transition table: satu UPDATE per berita untuk banyak like sekaligus (misalnya semua like
-- satu akun yang dihapus), dan baris posts dikunci berurutan id sehingga dua penghapusan massal tidak saling deadlock.
-- Saat berita dihapus, kaskade post_likes tidak menemukan baris posts lagi (0 baris) dan tidak gagal.
CREATE FUNCTION app.post_likes_count_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM app.posts p
  WHERE p.id IN (SELECT i.post_id FROM inserted_likes i)
  ORDER BY p.id
  FOR NO KEY UPDATE;
  UPDATE app.posts p
  SET like_count = p.like_count + d.n
  FROM (SELECT i.post_id, count(*)::integer AS n FROM inserted_likes i GROUP BY i.post_id) AS d
  WHERE p.id = d.post_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.post_likes_count_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM app.posts p
  WHERE p.id IN (SELECT o.post_id FROM deleted_likes o)
  ORDER BY p.id
  FOR NO KEY UPDATE;
  UPDATE app.posts p
  SET like_count = p.like_count - d.n
  FROM (SELECT o.post_id, count(*)::integer AS n FROM deleted_likes o GROUP BY o.post_id) AS d
  WHERE p.id = d.post_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER post_likes_count_insert AFTER INSERT ON app.post_likes
  REFERENCING NEW TABLE AS inserted_likes
  FOR EACH STATEMENT EXECUTE FUNCTION app.post_likes_count_insert();
--> statement-breakpoint
CREATE TRIGGER post_likes_count_delete AFTER DELETE ON app.post_likes
  REFERENCING OLD TABLE AS deleted_likes
  FOR EACH STATEMENT EXECUTE FUNCTION app.post_likes_count_delete();
--> statement-breakpoint
-- UPDATE baris post_likes tidak bermakna (PK = post_id, user_id) dan ditolak agar penghitung tidak pernah bergeser.
CREATE FUNCTION app.post_likes_forbid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Baris post_likes tidak dapat diubah; hapus like lalu tambahkan like baru'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'post_likes_immutable_chk',
          SCHEMA = 'app',
          TABLE = 'post_likes';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER post_likes_forbid_update BEFORE UPDATE ON app.post_likes
  FOR EACH ROW EXECUTE FUNCTION app.post_likes_forbid_update();
--> statement-breakpoint
-- TRUNCATE (hanya pemilik tabel) tidak menjalankan trigger baris/transition table: nolkan penghitung yang tersisa.
CREATE FUNCTION app.post_likes_truncate_count() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE app.posts SET like_count = 0 WHERE like_count <> 0;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER post_likes_truncate_count AFTER TRUNCATE ON app.post_likes
  FOR EACH STATEMENT EXECUTE FUNCTION app.post_likes_truncate_count();
