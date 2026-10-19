import type {
  AccountDeletion,
  AccountDeletionDisclosure,
  OtpChallenge,
  WebDeletionVerification,
} from "./delete-account";

/**
 * Fixture uji alur hapus akun, mengikuti skema account.yaml/auth.yaml persis (dipakai *.test.ts saja).
 * Waktu dasar 13 Okt 2026 00:00:00 UTC.
 */
export const T0 = Date.parse("2026-10-13T00:00:00Z");
export const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

export const CHALLENGE: OtpChallenge = {
  challenge_id: "0192f6a0-1111-7000-8000-000000000001",
  purpose: "deletion",
  email_masked: "ah***@kapdh.test",
  expires_at: iso(10 * 60_000),
  resend_available_at: iso(60_000),
  attempts_left: 5,
  max_attempts: 5,
};

export const DISCLOSURE: AccountDeletionDisclosure = {
  version: "v1-abc",
  estimated_completion_days: 7,
  backup_retention_days: 30,
  deleted_data: [
    { category: "credentials", description: "Email dan sandi untuk masuk." },
    { category: "profile", description: "Profil, foto dan kontak." },
  ],
  retained_data: [
    { category: "payments", description: "Jumlah, tanggal dan status pembayaran tanpa identitas." },
  ],
  privacy_policy_slug: "kebijakan-privasi",
  privacy_policy_version: "3",
  active_tickets: [],
  pending_refunds: [],
  open_payments: [],
  sole_admin_group_count: 0,
  linked_admin_identity: false,
};

export const DISCLOSURE_WITH_WARNINGS: AccountDeletionDisclosure = {
  ...DISCLOSURE,
  version: "v2-warn",
  active_tickets: [
    {
      ticket_id: "0192f6a0-2222-7000-8000-000000000001",
      event_id: "0192f6a0-3333-7000-8000-000000000001",
      event_title: "Reuni Akbar 2026",
      event_starts_at: "2026-11-01T02:00:00Z",
      event_timezone: "Asia/Jakarta",
      event_cancelled: false,
      status: "paid",
      total: "150000.00",
      refund_policy: "full_refund",
      self_cancel_deadline_at: "2026-10-29T02:00:00Z",
    },
  ],
  pending_refunds: [
    {
      adjustment_id: "0192f6a0-4444-7000-8000-000000000001",
      payment_id: "0192f6a0-5555-7000-8000-000000000001",
      payment_type: "ticket",
      ticket_id: "0192f6a0-6666-7000-8000-000000000001",
      event_title: "Camping KAPDH",
      amount: "75000.00",
      due_at: "2026-10-22T00:00:00Z",
      destination_provided: true,
      created_at: "2026-10-10T00:00:00Z",
    },
  ],
  open_payments: [
    {
      payment_id: "0192f6a0-7777-7000-8000-000000000001",
      type: "renewal",
      amount: "10000.00",
      proof_submitted: true,
      created_at: "2026-10-11T00:00:00Z",
    },
  ],
  sole_admin_group_count: 2,
  linked_admin_identity: true,
};

export const VERIFIED_DELETABLE: WebDeletionVerification = {
  email_masked: "ah***@kapdh.test",
  deletable: true,
  registration_pending: false,
  blocked_reason: null,
  deletion: null,
  disclosure: DISCLOSURE,
  deletion_token: "eyJ.deletion-token-yang-panjang.sig",
  deletion_token_expires_at: iso(10 * 60_000),
};

export const DELETION: AccountDeletion = {
  request_number: "DEL-2026-7K3Q9X",
  status: "pending",
  source: "web",
  requested_at: "2026-10-13T00:01:00Z",
  estimated_completion_at: "2026-10-20T00:01:00Z",
  completed_at: null,
};

export const VERIFIED_IN_PROGRESS: WebDeletionVerification = {
  email_masked: "ah***@kapdh.test",
  deletable: false,
  registration_pending: false,
  blocked_reason: "deletion_in_progress",
  deletion: { ...DELETION, status: "processing", source: "app" },
  disclosure: null,
  deletion_token: null,
  deletion_token_expires_at: null,
};

export const VERIFIED_DISABLED: WebDeletionVerification = {
  email_masked: "ah***@kapdh.test",
  deletable: false,
  registration_pending: false,
  blocked_reason: "account_disabled",
  deletion: null,
  disclosure: null,
  deletion_token: null,
  deletion_token_expires_at: null,
};
