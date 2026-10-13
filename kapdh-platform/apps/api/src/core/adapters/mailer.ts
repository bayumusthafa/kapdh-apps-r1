import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";

/** Tujuan OTP (PRD 2.5); email_change untuk koreksi email melalui alur terverifikasi (PRD 2.2). */
export type OtpPurpose = "signup" | "password_reset" | "deletion" | "email_change";

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
  sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void>;
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

export class SmtpMailer implements Mailer {
  private readonly transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: SUBJECT[purpose],
      text: `Kode Anda: ${code}\n\nKode berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk pengurus KAPDH.`,
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
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.logger.warn(`[DEV] OTP ${purpose} untuk ${to}: ${code}`);
  }
  async sendTransactional(mail: TransactionalMail): Promise<void> {
    this.logger.warn(`[DEV] email "${mail.subject}" untuk ${mail.to}`);
  }
}

/** Untuk uji: menyimpan kode terakhir per email dan email transaksional; kegagalan dapat dijadwalkan. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose }[] = [];
  readonly mail: TransactionalMail[] = [];
  private transactionalFailures = 0;
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
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
