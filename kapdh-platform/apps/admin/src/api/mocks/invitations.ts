import { type AdminRole, type Permission, PERMISSION_VALUES } from "@kapdh/contracts";
import { checkPassword } from "@kapdh/shared";
import { MOCK_CREDENTIALS, mockSignInAs } from "./auth";
import { error, json, type MockRequest, type MockRoute, type S } from "./http";

/**
 * Tiruan penerimaan undangan admin dan pendaftaran TOTP (kontrak admin-auth C1, F-16, PRD 8.2 langkah 2-5):
 * - token undangan hanya diterima di BODY (`invite_token`), tidak pernah di path/query; pratinjau tidak
 *   mengonsumsi token; token tidak dikenal/kedaluwarsa/terpakai = 410 OTP_EXPIRED (tidak dibedakan);
 * - penerimaan mengganti sandi awal (aturan byte PRD 2.5, ditolak 400 `field_errors.password`) dan menerbitkan
 *   token PENDAFTARAN 30 menit (`totp_enrollment_required: true`);
 * - /totp/enroll dan /totp/confirm hanya menerima token pendaftaran: token tidak sah 401, aktivasi sudah selesai
 *   403, kode salah 400 `field_errors.totp_code` dengan sisa percobaan, 5 kegagalan 429;
 * - konfirmasi berhasil: admin aktif, 10 backup code (sekali tampil) dan sesi admin baru.
 * Data contoh bukan bukti AC (PRD 7.3).
 */

/** Token undangan contoh yang berlaku (tautan dev:mock: /invite#t=<token>). */
export const MOCK_INVITE_TOKEN = "undangan-contoh-7Kq2M9xD4fW8pL3z";
/** Token undangan contoh yang sudah kedaluwarsa (410 OTP_EXPIRED). */
export const MOCK_EXPIRED_INVITE_TOKEN = "undangan-kedaluwarsa-0000000000";
/** Secret TOTP tiruan (base32) yang ditampilkan saat pendaftaran. */
export const MOCK_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const ENROLL_TTL_MS = 30 * 60_000;
const MAX_CODE_FAILURES = 5;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

interface Invitation {
  admin_id: string;
  email: string;
  email_masked: string;
  display_name: string;
  role: AdminRole;
  permissions: Permission[];
  invited_by_display_name: string | null;
  expires_at: string;
  has_linked_alumni: boolean;
  consumed: boolean;
  activated: boolean;
}

interface Enrollment {
  token: string;
  expiresAt: number;
  invitation: Invitation;
  secretIssued: boolean;
  failures: number;
}

export interface InvitationRequestLog {
  method: string;
  path: string;
  /** Kunci body (tanpa nilai token/sandi) dan query, untuk uji bahwa token hanya ada di body. */
  bodyKeys: string[];
  query: string;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint undangan/pendaftaran (uji: token hanya di body, tidak di URL). */
export const invitationRequests: InvitationRequestLog[] = [];

let invitations = new Map<string, Invitation>();
let enrollment: Enrollment | null = null;
let tokenSeq = 0;
let rateLimitNext = false;

function fixtures(): Map<string, Invitation> {
  const day = 24 * 3_600_000;
  return new Map<string, Invitation>([
    [
      MOCK_INVITE_TOKEN,
      {
        admin_id: "0199e000-0000-7000-8000-0000000001a1",
        email: "siti.rahmawati@kapdh.test",
        email_masked: "si***@kapdh.test",
        display_name: "Siti Rahmawati",
        role: "admin",
        permissions: ["payments.read", "payments.decide", "members.read"],
        invited_by_display_name: "Bayu Musthafa",
        expires_at: new Date(Date.now() + 3 * day).toISOString(),
        has_linked_alumni: true,
        consumed: false,
        activated: false,
      },
    ],
    [
      MOCK_EXPIRED_INVITE_TOKEN,
      {
        admin_id: "0199e000-0000-7000-8000-0000000001a2",
        email: "lama@kapdh.test",
        email_masked: "la***@kapdh.test",
        display_name: "Admin Lama",
        role: "admin",
        permissions: ["content.manage"],
        invited_by_display_name: "Bayu Musthafa",
        expires_at: new Date(Date.now() - day).toISOString(),
        has_linked_alumni: false,
        consumed: false,
        activated: false,
      },
    ],
  ]);
}

export function reset(): void {
  invitations = fixtures();
  enrollment = null;
  tokenSeq = 0;
  rateLimitNext = false;
  invitationRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  invitationRequests.push({
    method: req.method,
    path: req.path,
    bodyKeys: Object.keys(req.body ?? {}),
    query: req.url.search,
    body: req.body,
  });
}

function rateLimited(): Response | null {
  if (!rateLimitNext) return null;
  rateLimitNext = false;
  return error(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", { retry_after_seconds: 60 });
}

function validInvitation(token: unknown): Invitation | null {
  if (typeof token !== "string") return null;
  const inv = invitations.get(token);
  if (!inv || inv.consumed || Date.parse(inv.expires_at) <= Date.now()) return null;
  return inv;
}

function inviteGone(): Response {
  return error(410, "OTP_EXPIRED", "Undangan tidak berlaku lagi. Minta undangan baru ke Super Admin.");
}

function tokenShapeError(token: unknown): Response | null {
  if (typeof token !== "string" || token.length < 16 || token.length > 512)
    return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
      field_errors: { invite_token: ["Token undangan tidak valid."] },
    });
  return null;
}

/** Pemeriksaan token pendaftaran berurutan seperti server: 401 token, 403 aktivasi selesai. */
function checkEnrollment(token: unknown): { enrollment: Enrollment } | { response: Response } {
  if (!enrollment || token !== enrollment.token || enrollment.expiresAt <= Date.now())
    return {
      response: error(
        401,
        "UNAUTHENTICATED",
        "Token pendaftaran tidak berlaku lagi. Minta undangan ulang ke Super Admin.",
      ),
    };
  if (enrollment.invitation.activated)
    return {
      response: error(
        403,
        "FORBIDDEN",
        "Aktivasi sudah selesai. Masuk dengan sandi dan kode autentikator.",
      ),
    };
  return { enrollment };
}

function randomBase32(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE32[Math.floor(Math.random() * BASE32.length)];
  return out;
}

/** 10 backup code berbentuk XXXXX-XXXXX seperti server (core/identity/crypto.ts). */
function newBackupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = randomBase32(10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockInvitations = {
  /** Permintaan undangan berikutnya ditolak 429 RATE_LIMITED. */
  rateLimitNext(): void {
    rateLimitNext = true;
  },
  /** Token pendaftaran yang sedang berjalan kedaluwarsa (30 menit lewat). */
  expireEnrollment(): void {
    if (enrollment) enrollment.expiresAt = Date.now() - 1;
  },
  /** Aktivasi selesai di luar tab ini (mis. respons konfirmasi sebelumnya hilang). */
  completeActivationElsewhere(): void {
    if (enrollment) enrollment.invitation.activated = true;
  },
  /** Batalkan undangan (mis. Super Admin menghapus identitas) sehingga token menjadi 410. */
  revoke(token: string): void {
    invitations.delete(token);
  },
};

export const routes: MockRoute[] = [
  {
    method: "POST",
    path: "/admin/auth/invitations/preview",
    handler: (req) => {
      log(req);
      const limited = rateLimited();
      if (limited) return limited;
      const shape = tokenShapeError(req.body?.invite_token);
      if (shape) return shape;
      const inv = validInvitation(req.body?.invite_token);
      if (!inv) return inviteGone();
      const preview: S["AdminInvitationPreview"] = {
        email_masked: inv.email_masked,
        display_name: inv.display_name,
        role: inv.role,
        permissions: inv.role === "super_admin" ? [...PERMISSION_VALUES] : [...inv.permissions],
        invited_by_display_name: inv.invited_by_display_name,
        expires_at: inv.expires_at,
      };
      return json(200, preview);
    },
  },
  {
    method: "POST",
    path: "/admin/auth/invitations/accept",
    handler: (req) => {
      log(req);
      const limited = rateLimited();
      if (limited) return limited;
      const shape = tokenShapeError(req.body?.invite_token);
      if (shape) return shape;
      const password = req.body?.password;
      const check = typeof password === "string" ? checkPassword(password) : null;
      if (!check?.valid)
        return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
          field_errors: {
            password: [
              "Sandi wajib 8-72 byte dengan huruf besar, huruf kecil, angka, dan simbol (PRD 2.5).",
            ],
          },
        });
      const inv = validInvitation(req.body?.invite_token);
      if (!inv) return inviteGone();
      // Token dikonsumsi: penerimaan kedua (termasuk yang kalah balapan) mendapat 410.
      inv.consumed = true;
      tokenSeq += 1;
      enrollment = {
        token: `mock-enroll-${tokenSeq}`,
        expiresAt: Date.now() + ENROLL_TTL_MS,
        invitation: inv,
        secretIssued: false,
        failures: 0,
      };
      const res: S["AdminLoginResponse"] = {
        mfa_token: enrollment.token,
        mfa_expires_at: new Date(enrollment.expiresAt).toISOString(),
        totp_enrollment_required: true,
      };
      return json(200, res);
    },
  },
  {
    method: "POST",
    path: "/admin/auth/totp/enroll",
    handler: (req) => {
      log(req);
      const limited = rateLimited();
      if (limited) return limited;
      const checked = checkEnrollment(req.body?.mfa_token);
      if ("response" in checked) return checked.response;
      checked.enrollment.secretIssued = true;
      const email = checked.enrollment.invitation.email;
      const issuer = "KAPDH Admin";
      const res: S["AdminTotpEnrollment"] = {
        secret: MOCK_TOTP_SECRET,
        otpauth_uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${MOCK_TOTP_SECRET}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
        issuer,
        account_name: email,
        algorithm: "SHA1",
        digits: 6,
        period_seconds: 30,
      };
      return json(200, res);
    },
  },
  {
    method: "POST",
    path: "/admin/auth/totp/confirm",
    handler: (req) => {
      log(req);
      const checked = checkEnrollment(req.body?.mfa_token);
      if ("response" in checked) return checked.response;
      const e = checked.enrollment;
      if (e.failures >= MAX_CODE_FAILURES)
        return error(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", {
          retry_after_seconds: 900,
        });
      if (!e.secretIssued)
        return error(400, "VALIDATION_ERROR", "Pendaftaran belum dimulai.", {
          field_errors: { totp_code: ["Pindai kode QR terlebih dahulu."] },
        });
      if (req.body?.totp_code !== MOCK_CREDENTIALS.totp) {
        e.failures += 1;
        return error(400, "VALIDATION_ERROR", "Kode salah.", {
          field_errors: {
            totp_code: [`Kode autentikator salah. Sisa percobaan ${MAX_CODE_FAILURES - e.failures}.`],
          },
        });
      }
      e.invitation.activated = true;
      const codes = newBackupCodes();
      const session = mockSignInAs({
        admin_id: e.invitation.admin_id,
        email: e.invitation.email,
        display_name: e.invitation.display_name,
        role: e.invitation.role,
        permissions: e.invitation.permissions,
        has_linked_alumni: e.invitation.has_linked_alumni,
        backup_codes: codes,
      });
      const res: S["AdminTotpEnrollmentResult"] = {
        session,
        backup_codes: codes,
        backup_codes_generated_at: new Date().toISOString(),
      };
      return json(200, res);
    },
  },
];
