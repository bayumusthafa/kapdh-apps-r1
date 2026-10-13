import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";

/** Tujuan OTP (PRD 2.5); email_change untuk koreksi email melalui alur terverifikasi (PRD 2.2). */
export type OtpPurpose = "signup" | "password_reset" | "deletion" | "email_change";

/**
 * Email transaksional teks polos yang dikirim worker dari outbox (ARCHITECTURE §4.7), mis. undangan admin dan
 * pemberitahuan keamanan (F-16). Isi tidak pernah dicatat di log lingkungan nyata (N-14).
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Pengirim email. OTP dikirim sinkron oleh API karena kritis waktu dan pengguna dapat mengirim ulang (ADR-004);
 * email transaksional lain melalui outbox dan worker (ARCHITECTURE §4.7) lewat `send`.
 */
export interface Mailer {
  sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void>;
  /** Email transaksional dari handler outbox (undangan admin, pemberitahuan keamanan, F-16). */
  send(message: MailMessage): Promise<void>;
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
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
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
  async send(message: MailMessage): Promise<void> {
    // Development saja: tautan undangan perlu terlihat tanpa SMTP (sama dengan OTP di atas).
    this.logger.warn(`[DEV] Email untuk ${message.to}: ${message.subject}\n${message.text}`);
  }
}

/** Untuk uji: menyimpan kode terakhir per email dan email transaksional yang dikirim. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose }[] = [];
  readonly messages: MailMessage[] = [];
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
  }
  async send(message: MailMessage): Promise<void> {
    this.messages.push({ ...message });
  }
  last(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.code;
  }
  /** Email transaksional terakhir ke alamat ini. */
  lastMessage(to: string): MailMessage | undefined {
    return [...this.messages].reverse().find((m) => m.to === to);
  }
}
