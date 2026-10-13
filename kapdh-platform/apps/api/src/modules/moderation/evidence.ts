import { z } from "zod";
import { REPORT_EVIDENCE_FILE_IDS_KEY } from "../../core/files/files.service.js";

/**
 * Bentuk penyimpanan `reports.evidence` (jsonb) — bukti terminimalkan yang dicatat SAAT laporan dibuat (PRD 3.12, D2;
 * kontrak AdminModerationEvidence): hanya pesan yang dilaporkan dan konteks pilihan pelapor, snapshot profil publik
 * minimum, metadata grup, atau (banding) snapshot suspend yang dibanding. Tidak ada riwayat chat lain.
 *
 * - `file_ids`: semua berkas yang dirujuk snapshot (gambar pesan, avatar profil/grup) agar FilesService menahannya
 *   selama laporan disimpan walaupun pesan dihapus atau avatar diganti (retensi D2, core/files).
 * - Identitas pihak yang akunnya kemudian dihapus ditampilkan anonim saat dibaca (D2), bukan dari snapshot.
 * - Isi bukti tidak pernah disalin ke audit atau log (ARCHITECTURE §2 butir 3).
 */
export const EVIDENCE_VERSION = 1;

/** Nama kunci `file_ids` wajib sama dengan yang dibaca retensi core/files (cek waktu kompilasi). */
const FILE_IDS_KEY: "file_ids" = REPORT_EVIDENCE_FILE_IDS_KEY;
void FILE_IDS_KEY;

const messageSchema = z.object({
  message_id: z.string(),
  reported: z.boolean(),
  sender_user_id: z.string().nullable(),
  sender_name: z.string().nullable(),
  kind: z.enum(["text", "image", "system"]),
  body: z.string().nullable(),
  image_file_id: z.string().nullable(),
  created_at: z.string(),
});

const roomSchema = z.object({
  room_id: z.string(),
  kind: z.enum(["direct", "group"]),
  name: z.string().nullable(),
  avatar_file_id: z.string().nullable(),
  member_count: z.number().int().min(0),
});

const profileSchema = z.object({
  user_id: z.string(),
  full_name: z.string().nullable(),
  bio: z.string().nullable(),
  avatar_file_id: z.string().nullable(),
});

const contestedSchema = z.object({
  membership_event_id: z.string().nullable(),
  suspended_at: z.string(),
  suspension_reason: z.string().nullable(),
  suspension_message: z.string().nullable(),
  suspended_by_admin_id: z.string().nullable(),
});

export const storedEvidenceSchema = z.object({
  v: z.literal(EVIDENCE_VERSION),
  captured_at: z.string(),
  file_ids: z.array(z.string()),
  /** Nama grup saat laporan dibuat (laporan grup atau pesan di grup); null untuk direct/pengguna. */
  room_name: z.string().nullable(),
  messages: z.array(messageSchema).max(6),
  room: roomSchema.nullable(),
  profile: profileSchema.nullable(),
  contested_suspension: contestedSchema.nullable(),
});

export type StoredEvidence = z.infer<typeof storedEvidenceSchema>;
export type StoredEvidenceMessage = z.infer<typeof messageSchema>;
export type StoredEvidenceRoom = z.infer<typeof roomSchema>;
export type StoredEvidenceProfile = z.infer<typeof profileSchema>;
export type StoredContestedSuspension = z.infer<typeof contestedSchema>;

/** Membentuk bukti baru; `file_ids` diturunkan dari rujukan berkas snapshot (unik, tanpa null). */
export function buildEvidence(input: {
  capturedAt: Date;
  roomName?: string | null;
  messages?: StoredEvidenceMessage[];
  room?: StoredEvidenceRoom | null;
  profile?: StoredEvidenceProfile | null;
  contestedSuspension?: StoredContestedSuspension | null;
}): StoredEvidence {
  const messages = input.messages ?? [];
  const fileIds = [
    ...messages.map((message) => message.image_file_id),
    input.room?.avatar_file_id ?? null,
    input.profile?.avatar_file_id ?? null,
  ].filter((id): id is string => typeof id === "string");
  return {
    v: EVIDENCE_VERSION,
    captured_at: input.capturedAt.toISOString(),
    file_ids: [...new Set(fileIds)],
    room_name: input.roomName ?? null,
    messages,
    room: input.room ?? null,
    profile: input.profile ?? null,
    contested_suspension: input.contestedSuspension ?? null,
  };
}

/** Bukti tersimpan yang tidak dapat dibaca (data rusak) tampil kosong, bukan 500. */
export function parseEvidence(raw: unknown, fallbackCapturedAt: Date): StoredEvidence {
  const parsed = storedEvidenceSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return buildEvidence({ capturedAt: fallbackCapturedAt });
}
