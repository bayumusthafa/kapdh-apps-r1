import { users } from "@kapdh/database";
import { eq } from "drizzle-orm";
import type { Tx } from "../../core/db/types.js";

/**
 * Urutan kunci sesi (AC F02-3, F02-4, F02-6, F13-5; N-08; ARCHITECTURE §2 "tanpa jalan pintas konkurensi").
 *
 * Masalah yang dicegah: di READ COMMITTED, pernyataan pencabutan (`UPDATE sessions ... WHERE revoked_at IS NULL`)
 * yang menunggu kunci baris sesi yang sedang DIROTASI akan melewati baris itu setelah rotasi commit (sudah dicabut),
 * dan TIDAK melihat baris baru hasil rotasi karena snapshot pernyataannya diambil sebelum commit. Keluarga sesi
 * pencuri bertahan walau logout semua/pencabutan sesi/deteksi pemakaian ulang sudah menjawab sukses.
 *
 * Aturan: setiap transaksi yang MENERBITKAN atau MEROTASI sesi memegang kunci baris `users` pemiliknya sebelum
 * menyentuh baris sesi, dan setiap transaksi yang MENCABUT sesi mengunci baris `users` FOR UPDATE sebagai pernyataan
 * PERTAMA. FOR UPDATE bentrok dengan FOR SHARE (rotasi refresh, {@link lockOwnerForRotation}), FOR NO KEY UPDATE
 * (login dan aktivasi yang memperbarui baris users), dan FOR KEY SHARE (pemeriksaan FK `sessions.user_id` pada INSERT
 * sesi baru di jalur penerbitan mana pun). Akibatnya pencabutan selalu berjalan SEPENUHNYA sebelum atau sesudah
 * rotasi/penerbitan:
 * - pencabutan lebih dulu: rotasi menunggu, lalu UPDATE bersyaratnya pada baris lama gagal (sudah dicabut) → 401;
 * - rotasi/penerbitan lebih dulu: pencabutan menunggu commit-nya, lalu pernyataan berikutnya memakai snapshot baru
 *   yang melihat baris sesi baru dan ikut mencabutnya.
 * Kunci diambil sebelum baris sesi mana pun sehingga tidak ada siklus tunggu (deadlock 40P01).
 */
export async function lockOwnerForRevocation(tx: Tx, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

/**
 * Kunci rotasi refresh (AC F02-3, F02-6): FOR SHARE pada baris users pemilik sebagai pernyataan pertama transaksi
 * rotasi, lalu status dan jenis akun dinilai di bawah kunci itu. Rotasi bersamaan untuk pengguna yang sama tidak saling
 * menunggu (SHARE kompatibel), tetapi setiap pencabutan sesi ({@link lockOwnerForRevocation}) dan setiap perubahan
 * baris users (penonaktifan, penangguhan, penghapusan, reset/ganti sandi) menunggu rotasi ini selesai atau membuatnya
 * gagal. Mengembalikan undefined bila akun tidak ada.
 */
export async function lockOwnerForRotation(
  tx: Tx,
  userId: string,
): Promise<{ status: string; kind: string } | undefined> {
  const [owner] = await tx
    .select({ status: users.status, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .for("share");
  return owner;
}
