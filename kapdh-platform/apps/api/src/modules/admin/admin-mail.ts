import type { MailMessage } from "../../core/adapters/mailer.js";
import type { OutboxPayload } from "../../core/outbox/topics.js";

/**
 * Templat email pengurus (F-16, PRD 3.16, AC F16-1): teks polos Bahasa Indonesia tanpa data pribadi selain nama tampilan
 * penerima. Tautan undangan hanya ada di email ke alamat login yang berlaku dan tidak pernah dicatat (N-14).
 */

const DATETIME_WIB = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Contoh: `16 Oktober 2026 09.00 WIB`. */
export function formatDateTimeWib(instant: Date): string {
  return `${DATETIME_WIB.format(instant).replace(" pukul ", " ")} WIB`;
}

const FOOTER =
  "\n\nEmail ini dikirim otomatis oleh KAPDH Apps. Pengurus KAPDH tidak pernah meminta sandi, kode TOTP, atau " +
  "backup code Anda.";

export interface InvitationMailInput {
  to: string;
  displayName: string;
  link: string;
  expiresAt: Date;
  /** true = pemulihan admin yang pernah aktif (sandi dan MFA direset), false = undangan pertama. */
  recovery: boolean;
}

export function invitationMail(input: InvitationMailInput): MailMessage {
  const until = formatDateTimeWib(input.expiresAt);
  if (input.recovery)
    return {
      to: input.to,
      subject: "Pemulihan akun pengurus KAPDH Apps",
      text:
        `Yth. ${input.displayName},\n\n` +
        "Super Admin KAPDH memulihkan akun pengurus Anda. Sandi dan aplikasi autentikator (TOTP) lama sudah tidak " +
        "berlaku dan seluruh sesi telah diakhiri. Buka tautan berikut untuk membuat sandi baru dan mendaftarkan " +
        "autentikator lagi:\n\n" +
        `${input.link}\n\n` +
        `Tautan hanya dapat dipakai sekali dan berlaku sampai ${until}. Jangan teruskan email ini kepada siapa pun. ` +
        "Bila Anda tidak meminta pemulihan, segera hubungi Super Admin KAPDH." +
        FOOTER,
    };
  return {
    to: input.to,
    subject: "Undangan pengurus KAPDH Apps",
    text:
      `Yth. ${input.displayName},\n\n` +
      "Anda diundang menjadi pengurus (admin) KAPDH Apps. Buka tautan berikut untuk membuat sandi dan mendaftarkan " +
      "aplikasi autentikator (TOTP) sebelum akun aktif:\n\n" +
      `${input.link}\n\n` +
      `Tautan hanya dapat dipakai sekali dan berlaku sampai ${until}. Jangan teruskan email ini kepada siapa pun. ` +
      "Bila Anda tidak merasa diundang, abaikan email ini." +
      FOOTER,
  };
}

type NoticeKind = OutboxPayload<"admin.security_notice">["kind"];

const NOTICE: Record<NoticeKind, { subject: string; body: string }> = {
  invited: {
    subject: "Akun pengurus KAPDH Apps dibuat",
    body: "Identitas pengurus untuk alamat ini telah dibuat. Tautan aktivasi dikirim dalam email terpisah.",
  },
  permissions_changed: {
    subject: "Izin akun pengurus Anda diubah",
    body: "Izin akun pengurus KAPDH Apps Anda telah diubah oleh Super Admin dan langsung berlaku.",
  },
  role_changed: {
    subject: "Peran akun pengurus Anda diubah",
    body: "Peran akun pengurus KAPDH Apps Anda telah diubah oleh Super Admin dan langsung berlaku.",
  },
  disabled: {
    subject: "Akun pengurus Anda dinonaktifkan",
    body: "Akun pengurus KAPDH Apps Anda telah dinonaktifkan oleh Super Admin dan seluruh sesi telah diakhiri.",
  },
  mfa_reset: {
    subject: "Sandi dan autentikator akun pengurus Anda direset",
    body:
      "Super Admin memulihkan akun pengurus KAPDH Apps Anda: sandi dan autentikator (TOTP) lama tidak berlaku lagi " +
      "dan seluruh sesi telah diakhiri. Tautan pemulihan dikirim dalam email terpisah.",
  },
  password_changed: {
    subject: "Sandi akun pengurus Anda diubah",
    body: "Sandi akun pengurus KAPDH Apps Anda baru saja diubah.",
  },
  email_changed: {
    subject: "Email login akun pengurus Anda dialihkan",
    body: "Email login akun pengurus KAPDH Apps yang sebelumnya memakai alamat ini telah dialihkan oleh Super Admin.",
  },
};

export interface SecurityNoticeInput {
  to: string;
  displayName: string;
  kind: NoticeKind;
  at: Date;
  /** Alamat baru tersamar (`ab***@domain`) untuk pemberitahuan pengalihan email. */
  maskedNewEmail?: string | null;
}

/** Pemberitahuan keamanan admin (pola AC F16-4): pemilik sah mengetahui setiap perubahan atas aksesnya. */
export function securityNoticeMail(input: SecurityNoticeInput): MailMessage {
  const notice = NOTICE[input.kind];
  const target = input.maskedNewEmail ? ` Alamat baru: ${input.maskedNewEmail}.` : "";
  return {
    to: input.to,
    subject: notice.subject,
    text:
      `Yth. ${input.displayName},\n\n${notice.body}${target}\n\nWaktu: ${formatDateTimeWib(input.at)}.\n\n` +
      "Bila Anda tidak mengenali perubahan ini, segera hubungi Super Admin KAPDH." +
      FOOTER,
  };
}
