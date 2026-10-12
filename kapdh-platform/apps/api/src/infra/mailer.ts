import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";

export type OtpPurpose = "signup" | "password_reset" | "deletion";

export interface Mailer {
  sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void>;
}

const SUBJECT: Record<OtpPurpose, string> = {
  signup: "Kode verifikasi pendaftaran KAPDH",
  password_reset: "Kode pemulihan sandi KAPDH",
  deletion: "Kode konfirmasi penghapusan akun KAPDH",
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
}

/** Hanya untuk development tanpa SMTP. Config menolak mode ini di staging/production (N-14). */
export class DevLogMailer implements Mailer {
  private readonly logger = new Logger("DevLogMailer");
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.logger.warn(`[DEV] OTP ${purpose} untuk ${to}: ${code}`);
  }
}

/** Untuk uji: menyimpan kode terakhir per email. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose }[] = [];
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
  }
  last(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.code;
  }
}
