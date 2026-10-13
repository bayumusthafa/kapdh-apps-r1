import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";

/** Tujuan OTP (PRD 2.5); email_change untuk koreksi email melalui alur terverifikasi (PRD 2.2). */
export type OtpPurpose = "signup" | "password_reset" | "deletion" | "email_change";

/**
 * Email transaksional generik (F-13: notifikasi email per kategori; pemberitahuan lain dari worker). Isi disusun
 * pemanggil dari templat Bahasa Indonesia; tidak pernah memuat sandi, OTP, token, isi chat, atau bukti bayar
 * (ARCHITECTURE §2 butir 3).
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailSendResult {
  /** Message-ID yang diterima server SMTP/provider (diterima ≠ dibaca, F-13); null bila tidak dilaporkan. */
  messageId: string | null;
}

/**
 * Pengirim email. OTP dikirim sinkron oleh API karena kritis waktu dan pengguna dapat mengirim ulang (ADR-004);
 * email transaksional lain melalui outbox dan worker (ARCHITECTURE §4.7).
 */
export interface Mailer {
  sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void>;
  /**
   * Mengirim email transaksional. Galat SMTP diteruskan apa adanya (`code`, `responseCode`) agar pemanggil dapat
   * mengklasifikasi kegagalan (bounce permanen vs gangguan sementara, F-13).
   */
  send(message: MailMessage): Promise<MailSendResult>;
}

const SUBJECT: Record<OtpPurpose, string> = {
  signup: "Kode verifikasi pendaftaran KAPDH",
  password_reset: "Kode pemulihan sandi KAPDH",
  deletion: "Kode konfirmasi penghapusan akun KAPDH",
  email_change: "Kode verifikasi perubahan email KAPDH",
};

/** Subjek satu baris: CR/LF dibuang agar tidak dapat menyisipkan header (injeksi header email). */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

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
  async send(message: MailMessage): Promise<MailSendResult> {
    const info = (await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: singleLine(message.subject),
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      // Email otomatis (RFC 3834): penjawab otomatis tidak membalas ke noreply.
      headers: { "Auto-Submitted": "auto-generated" },
    })) as { messageId?: string; rejected?: unknown[] };
    // Penerima ditolak server (tanpa galat dilempar): diperlakukan sebagai penolakan amplop permanen.
    if (Array.isArray(info.rejected) && info.rejected.length > 0)
      throw Object.assign(new Error("Penerima email ditolak server SMTP"), { code: "EENVELOPE" });
    return { messageId: info.messageId ?? null };
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
  async send(message: MailMessage): Promise<MailSendResult> {
    // Hanya subjek dan penerima (development); isi email tidak dicetak.
    this.logger.warn(`[DEV] email "${singleLine(message.subject)}" untuk ${message.to}`);
    return { messageId: null };
  }
}

/** Untuk uji: menyimpan kode terakhir per email dan email transaksional; kegagalan SMTP dapat diantrekan. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose }[] = [];
  /** Email transaksional yang diterima (urutan kirim). */
  readonly messages: MailMessage[] = [];
  private readonly failures: unknown[] = [];
  private counter = 0;

  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
  }
  last(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.code;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    if (this.failures.length > 0) throw this.failures.shift();
    this.messages.push({ ...message });
    return { messageId: `<uji-${++this.counter}@kapdh.test>` };
  }
  /** Galat berikutnya untuk send() (antrean), mis. `{ responseCode: 550 }` atau `{ code: "ETIMEDOUT" }`. */
  failNext(error: unknown): void {
    this.failures.push(error);
  }
  /** Email transaksional untuk alamat tertentu. */
  messagesTo(to: string): MailMessage[] {
    return this.messages.filter((m) => m.to === to);
  }
}
