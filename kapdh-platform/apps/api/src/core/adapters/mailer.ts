import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";

/** Tujuan OTP (PRD 2.5); email_change untuk koreksi email melalui alur terverifikasi (PRD 2.2). */
export type OtpPurpose = "signup" | "password_reset" | "deletion" | "email_change";

/** Opsi tambahan email OTP (aditif; pemanggil lama tidak terpengaruh). */
export interface OtpMailOptions {
  /**
   * Challenge `password_reset` yang dimulai Super Admin (AC F16-4, kontrak adminInitiateMemberPasswordReset): email
   * memuat kode DAN satu-satunya tautan kanonik `kapdh://app/forgot/otp?challenge_id=<id>` (ARCHITECTURE §4.7, §8.4)
   * sehingga anggota menukar kode tanpa memulai ulang "Lupa sandi". Kode tidak pernah masuk URL.
   */
  adminInitiatedChallengeId?: string;
}

/** Tautan aplikasi ke layar OTP pemulihan yang terikat challenge (bentuk eksternal deep link, kontrak C1/C2). */
export function forgotOtpAppLink(challengeId: string): string {
  return `kapdh://app/forgot/otp?challenge_id=${encodeURIComponent(challengeId)}`;
}

/**
 * Email transaksional teks polos yang dikirim langsung oleh job, bukan lewat notifikasi inbox (mis. konfirmasi dan
 * penyelesaian penghapusan akun F-14: email penyelesaian wajib terkirim SEBELUM alamat akun dihapus, sehingga tidak
 * dapat menunggu pengiriman notifikasi asinkron). Isi tidak pernah memuat sandi, OTP, token, atau data bukti bayar
 * (ARCHITECTURE §2 butir 3) dan tidak pernah dicatat ke log.
 */
export interface TransactionalMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Pengirim email. OTP dikirim sinkron oleh API karena kritis waktu dan pengguna dapat mengirim ulang (ADR-004);
 * email transaksional lain melalui outbox dan worker (ARCHITECTURE §4.7).
 */
export interface Mailer {
  sendOtp(to: string, code: string, purpose: OtpPurpose, options?: OtpMailOptions): Promise<void>;
  /**
   * Email transaksional {@link TransactionalMail}; melempar bila gagal sehingga job pemanggil mengulang. Opsional
   * (penambahan fase C, F-14) agar implementasi Mailer lain tetap sah; SmtpMailer, DevLogMailer dan MemoryMailer
   * mengimplementasikannya, dan pemanggil memperlakukan ketiadaannya sebagai galat konfigurasi.
   */
  sendTransactional?(mail: TransactionalMail): Promise<void>;
}

const SUBJECT: Record<OtpPurpose, string> = {
  signup: "Kode verifikasi pendaftaran KAPDH",
  password_reset: "Kode pemulihan sandi KAPDH",
  deletion: "Kode konfirmasi penghapusan akun KAPDH",
  email_change: "Kode verifikasi perubahan email KAPDH",
};

/** Isi teks email OTP; versi pemulihan oleh pengurus menambah penjelasan dan tautan aplikasi (AC F16-4). */
export function otpMailText(code: string, options: OtpMailOptions = {}): string {
  const base = `Kode Anda: ${code}\n\nKode berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk pengurus KAPDH.`;
  if (!options.adminInitiatedChallengeId) return base;
  return [
    "Pengurus KAPDH memulai pemulihan sandi akun Anda. Demi keamanan, semua sesi akun Anda telah dikeluarkan.",
    "",
    base,
    "",
    `Buka tautan berikut di ponsel yang terpasang aplikasi KAPDH, lalu masukkan kode di atas: ${forgotOtpAppLink(options.adminInitiatedChallengeId)}`,
    "",
    'Bila tautan tidak dapat dibuka, gunakan menu "Lupa sandi" pada aplikasi. Bila Anda tidak meminta pemulihan ini, hubungi bantuan KAPDH.',
  ].join("\n");
}

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async sendOtp(to: string, code: string, purpose: OtpPurpose, options?: OtpMailOptions): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: SUBJECT[purpose],
      text: otpMailText(code, options),
    });
  }
  async sendTransactional(mail: TransactionalMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
  /** Menutup koneksi pool SMTP saat shutdown. */
  close(): void {
    this.transport.close();
  }
}

/**
 * Hanya untuk development tanpa SMTP: kode dicetak ke log lokal. Config menolak staging/production tanpa SMTP_URL
 * dan main.ts menolak mode ini di luar development (N-14: OTP tidak pernah dicatat di lingkungan nyata).
 */
export class DevLogMailer implements Mailer {
  private readonly logger = new Logger("DevLogMailer");
  async sendOtp(to: string, code: string, purpose: OtpPurpose, options?: OtpMailOptions): Promise<void> {
    const link = options?.adminInitiatedChallengeId
      ? ` (${forgotOtpAppLink(options.adminInitiatedChallengeId)})`
      : "";
    this.logger.warn(`[DEV] OTP ${purpose} untuk ${to}: ${code}${link}`);
  }
  async sendTransactional(mail: TransactionalMail): Promise<void> {
    this.logger.warn(`[DEV] email "${mail.subject}" untuk ${mail.to}`);
  }
}

/** Untuk uji: menyimpan kode terakhir per email beserta teks email lengkap, dan email transaksional; kegagalan dapat dijadwalkan. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose; text: string; options?: OtpMailOptions }[] =
    [];
  readonly mail: TransactionalMail[] = [];
  private transactionalFailures = 0;
  async sendOtp(to: string, code: string, purpose: OtpPurpose, options?: OtpMailOptions): Promise<void> {
    this.sent.push({ to, code, purpose, text: otpMailText(code, options), ...(options ? { options } : {}) });
  }
  async sendTransactional(mail: TransactionalMail): Promise<void> {
    if (this.transactionalFailures > 0) {
      this.transactionalFailures -= 1;
      throw new Error("Kegagalan SMTP tiruan");
    }
    this.mail.push({ ...mail });
  }
  /** Pengiriman transaksional berikutnya (sebanyak `times`) gagal, untuk menguji pengulangan job. */
  failNextTransactional(times = 1): void {
    this.transactionalFailures += times;
  }
  last(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.code;
  }
}
