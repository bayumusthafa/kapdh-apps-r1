/**
 * Batas, laju, dan teks modul chat (F-11, F-12; PRD 3.11, 3.12; D5 v3.2; kontrak domains/chat.yaml).
 * Batas isi teks (4.000) dan anggota grup (100) dibaca dari app_settings `chat` (SettingsService) dan tidak pernah
 * melampaui batas kontrak di bawah.
 */

/** Batas kontrak: body pesan maksimal 4.000 karakter (code point, sama dengan char_length PostgreSQL). */
export const CONTRACT_MAX_TEXT_CHARS = 4000;
/** Batas kontrak: grup maksimal 100 anggota (joined + undangan tertunda). */
export const CONTRACT_MAX_GROUP_MEMBERS = 100;
/** Nama grup 1..80 karakter setelah dipangkas (rooms_name_chk). */
export const MAX_GROUP_NAME_CHARS = 80;

/** Laju kirim pesan per pengguna (429 RATE_LIMITED, kontrak sendChatMessage). */
export const SEND_LIMIT = 60;
export const SEND_WINDOW_MS = 60_000;
/** Laju pembuatan grup per pengguna (429, kontrak createChatGroup). */
export const GROUP_CREATE_LIMIT = 10;
export const GROUP_CREATE_WINDOW_MS = 3600_000;
/** Laju permintaan undangan per pengguna (429, kontrak inviteChatMembers). */
export const INVITE_LIMIT = 30;
export const INVITE_WINDOW_MS = 3600_000;

/** Maksimal 10 emoji berbeda per pengguna per pesan (kontrak addChatReaction). */
export const MAX_REACTIONS_PER_USER = 10;
/** Batas emoji reaksi (message_reactions_emoji_chk, parameter ChatEmoji). */
export const MAX_EMOJI_CHARS = 16;
/** unread_count dibatasi 999 (ChatRoomSummary.unread_count). */
export const UNREAD_CAP = 999;
/** Pratinjau pesan terakhir / balasan maksimal 120 karakter (ChatMessagePreview.preview). */
export const PREVIEW_CHARS = 120;

/** Typing sementara (events/typing.schema.json): TTL indikator dan jeda minimal antar siaran per pengguna+room. */
export const TYPING_TTL_SECONDS = 5;
export const TYPING_THROTTLE_MS = 2_000;
/** Presence sementara (events/presence.schema.json): online berlaku TTL detik; siaran ulang paling cepat per jeda. */
export const PRESENCE_TTL_SECONDS = 60;
export const PRESENCE_THROTTLE_MS = 25_000;
/** Batas penerima siaran presence per ping (anggota room yang sama). */
export const PRESENCE_MAX_RECIPIENTS = 2_000;

/**
 * Masa berlaku URL berkas privat pada siaran realtime (gambar pesan, avatar pengirim/grup). URL siaran tidak terikat
 * sesi penerima (satu payload untuk seluruh kanal room), sehingga dibuat singkat: cukup untuk ditampilkan segera
 * (N-02), sesudahnya klien memakai URL terikat sesi dari riwayat HTTP (PRD 5.4, AC F11-4).
 */
export const REALTIME_FILE_URL_TTL_SECONDS = 120;

/** Penghapusan akun: jumlah maksimal event message.deleted yang disiarkan (sisanya lewat muat ulang jendela, C6 butir 7). */
export const DELETION_EVENT_CAP = 500;

/** Nama tampilan akun yang sudah dihapus (ChatRoomSummary.title). */
export const DELETED_ACCOUNT_NAME = "Akun dihapus";

/** Pesan galat (Bahasa Indonesia, PRD 4.5). */
export const MSG = {
  roomNotFound: "Percakapan tidak ditemukan.",
  messageNotFound: "Pesan tidak ditemukan.",
  invitationNotFound: "Undangan tidak ditemukan atau sudah tidak berlaku.",
  memberNotFound: "Anggota tidak ditemukan di grup ini.",
  peerNotFound: "Anggota tidak ditemukan atau tidak dapat dihubungi.",
  /** Sama untuk blokir oleh lawan bicara dan lawan bicara nonaktif agar blokir tidak terungkap (N-09, AC F12-1). */
  peerUnavailable: "Anggota ini tidak dapat menerima pesan saat ini.",
  youBlocked: "Anda memblokir anggota ini. Buka blokir untuk mengirim pesan.",
  roomClosed: "Grup sudah ditutup.",
  notGroupAdmin: "Hanya admin grup yang dapat melakukan tindakan ini.",
  directRoomOnlyGroup: "Tindakan ini hanya untuk grup.",
  sendRateLimited: "Terlalu banyak pesan dalam waktu singkat. Coba lagi sebentar lagi.",
  groupRateLimited: "Terlalu banyak grup dibuat. Coba lagi nanti.",
  inviteRateLimited: "Terlalu banyak undangan dikirim. Coba lagi nanti.",
  clientMessageConflict: "client_message_id sudah dipakai untuk pesan lain. Buat ID baru untuk pesan ini.",
} as const;
