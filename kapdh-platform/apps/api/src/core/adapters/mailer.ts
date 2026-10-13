import { Logger } from "@nestjs/common";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import SMTPConnection, { type SMTPConnectionOptions } from "nodemailer/lib/smtp-connection";
import SMTPTransport from "nodemailer/lib/smtp-transport";

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
  /**
   * Kunci stabil pesan (mis. id notification_deliveries). SmtpMailer menjadikannya Message-ID `<kunci@domain-pengirim>`
   * sehingga percobaan ulang pesan yang SAMA memakai Message-ID yang sama: bila balasan server hilang tepat setelah
   * pesan diterima, salinan kedua dikenali penerima sebagai pesan yang sama (F-13, retry tanpa efek ganda PRD 5.1).
   */
  dedupKey?: string;
}

export interface MailSendOptions {
  /**
   * Pembatalan dari pemanggil (batas waktu percobaan, F-13): koneksi SMTP DITUTUP segera sehingga pesan yang belum
   * selesai dikirim (akhir DATA) tidak pernah diterima server, lalu janji ditolak dengan `signal.reason`.
   */
  signal?: AbortSignal;
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
   * mengklasifikasi kegagalan (bounce permanen vs gangguan sementara, F-13). `options.signal` memutus pengiriman.
   */
  send(message: MailMessage, options?: MailSendOptions): Promise<MailSendResult>;
}

/** Alasan pembatalan sebagai Error yang dapat diklasifikasi (default: batas waktu, `ETIMEDOUT`). */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Pengiriman email dibatalkan sebelum diterima server"), {
    code: "ETIMEDOUT",
  });
}

/**
 * Batas waktu koneksi SMTP untuk email transaksional (F-13), di bawah batas waktu percobaan pengiriman (60 detik):
 * koneksi + DNS + sapaan + STARTTLS dibatasi `connectionTimeout`, dan setiap perintah yang tidak dibalas dihentikan
 * `socketTimeout` (bawaan nodemailer 2 menit dan 10 menit). Nilai yang lebih kecil di query SMTP_URL tetap dihormati.
 */
export const SMTP_SEND_TIMEOUTS = {
  dnsTimeout: 10_000,
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const satisfies Partial<SMTPConnectionOptions>;

type SmtpTimeouts = { -readonly [K in keyof typeof SMTP_SEND_TIMEOUTS]: number };

/** Domain alamat pengirim untuk Message-ID (`"KAPDH <noreply@kapdh.or.id>"` → `kapdh.or.id`). */
function senderDomain(from: string): string {
  const match = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from.trim());
  return match?.[1] ?? "kapdh.invalid";
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
  /** Opsi koneksi untuk send(): hasil resolusi SMTP_URL oleh nodemailer (URL + layanan dikenal) dengan batas waktu. */
  private readonly connectionOptions: SMTPConnectionOptions & { forceAuth?: boolean | undefined };
  private readonly auth: SMTPTransport["auth"];
  private readonly domain: string;
  constructor(
    url: string,
    private readonly from: string,
    options: { timeouts?: Partial<SmtpTimeouts> } = {},
  ) {
    this.transport = nodemailer.createTransport(url);
    // Resolusi opsi koneksi dan kredensial memakai logika nodemailer sendiri (parseConnectionUrl + well-known).
    const resolved = new SMTPTransport(url);
    const limits = { ...SMTP_SEND_TIMEOUTS, ...options.timeouts };
    const bounded = (key: keyof SmtpTimeouts) => Math.min(resolved.options[key] ?? limits[key], limits[key]);
    this.connectionOptions = {
      ...resolved.options,
      dnsTimeout: bounded("dnsTimeout"),
      connectionTimeout: bounded("connectionTimeout"),
      greetingTimeout: bounded("greetingTimeout"),
      socketTimeout: bounded("socketTimeout"),
    };
    this.auth = resolved.getAuth();
    this.domain = senderDomain(from);
  }
  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: SUBJECT[purpose],
      text: `Kode Anda: ${code}\n\nKode berlaku 10 menit. Jangan berikan kode ini kepada siapa pun, termasuk pengurus KAPDH.`,
    });
  }
  /**
   * Satu koneksi SMTP per pesan (seperti transport nodemailer tanpa pool), tetapi koneksinya dipegang di sini agar
   * pembatalan pemanggil (`options.signal`, batas waktu percobaan F-13) benar-benar MENUTUPNYA: aliran DATA dilepas dan
   * socket ditutup sehingga pesan yang belum mencapai akhir DATA dibuang server, bukan terkirim belakangan lalu
   * terkirim lagi oleh percobaan ulang. Galat SMTP diteruskan apa adanya (code/responseCode) untuk klasifikasi.
   */
  async send(message: MailMessage, options: MailSendOptions = {}): Promise<MailSendResult> {
    const { signal } = options;
    if (signal?.aborted) throw abortError(signal);
    const mime = new MailComposer({
      from: this.from,
      to: message.to,
      subject: singleLine(message.subject),
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      // Email otomatis (RFC 3834): penjawab otomatis tidak membalas ke noreply.
      headers: { "Auto-Submitted": "auto-generated" },
      ...(message.dedupKey ? { messageId: this.messageIdFor(message.dedupKey) } : {}),
    }).compile();
    const envelope = mime.getEnvelope();
    const messageId = mime.messageId();
    const connection = new SMTPConnection(this.connectionOptions);
    return new Promise<MailSendResult>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: MailSendResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        connection.close();
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(result ?? { messageId });
      };
      const onAbort = () => finish(abortError(signal!));
      signal?.addEventListener("abort", onAbort, { once: true });
      // `on`, bukan `once`: galat susulan saat koneksi ditutup tidak boleh menjadi 'error' tanpa listener (crash).
      connection.on("error", (error: unknown) => finish(error));
      connection.once("end", () =>
        finish(
          Object.assign(new Error("Koneksi SMTP ditutup sebelum pesan diterima"), { code: "ECONNECTION" }),
        ),
      );
      connection.connect((connectError) => {
        if (connectError) return finish(connectError);
        if (settled) return;
        const deliver = () =>
          connection.send(envelope, mime.createReadStream(), (sendError, info) => {
            if (sendError) return finish(sendError);
            // Penerima ditolak server (tanpa galat dilempar): diperlakukan sebagai penolakan amplop permanen.
            if (info && Array.isArray(info.rejected) && info.rejected.length > 0)
              return finish(
                Object.assign(new Error("Penerima email ditolak server SMTP"), { code: "EENVELOPE" }),
              );
            finish(null, { messageId });
          });
        if (this.auth && (connection.allowsAuth || this.connectionOptions.forceAuth))
          connection.login(this.auth, (loginError) => (loginError ? finish(loginError) : deliver()));
        else deliver();
      });
    });
  }

  /** Message-ID stabil per kunci pesan: hanya karakter aman bagian lokal, domain = domain pengirim. */
  private messageIdFor(key: string): string {
    const local = key.replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 120) || "pesan";
    return `<${local}.notifikasi@${this.domain}>`;
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

/** Pengiriman yang ditahan MemoryMailer (server SMTP lambat), lihat {@link MemoryMailer.holdNext}. */
export interface MailHold {
  /** Server "menerima" pesan; tidak berpengaruh bila pengiriman sudah dibatalkan. */
  release(): void;
  /** Terpenuhi saat pengiriman yang ditahan dimulai, dengan sinyal pembatalan dari pemanggil (bila ada). */
  started: Promise<AbortSignal | undefined>;
}

/** Untuk uji: menyimpan kode terakhir per email dan email transaksional; kegagalan SMTP dapat diantrekan. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; code: string; purpose: OtpPurpose }[] = [];
  /** Email transaksional yang diterima (urutan kirim). */
  readonly messages: MailMessage[] = [];
  /** Email yang pengirimannya dibatalkan pemanggil sebelum diterima (tidak pernah masuk `messages`). */
  readonly aborted: MailMessage[] = [];
  private readonly failures: unknown[] = [];
  private readonly holds: { released: Promise<void>; start(signal: AbortSignal | undefined): void }[] = [];
  private counter = 0;

  async sendOtp(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
  }
  last(to: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.to === to)?.code;
  }

  /**
   * Meniru SmtpMailer: pembatalan `options.signal` menutup "koneksi" sebelum pesan diterima, sehingga pesan yang
   * dibatalkan tidak pernah diterima walaupun server kemudian "membalas".
   */
  async send(message: MailMessage, options: MailSendOptions = {}): Promise<MailSendResult> {
    const { signal } = options;
    if (signal?.aborted) throw abortError(signal);
    if (this.failures.length > 0) throw this.failures.shift();
    const hold = this.holds.shift();
    if (hold) {
      hold.start(signal);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.aborted.push({ ...message });
          reject(abortError(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        void hold.released.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    }
    this.messages.push({ ...message });
    return { messageId: `<uji-${++this.counter}@kapdh.test>` };
  }
  /** Pengiriman berikutnya ditahan sampai `release()` atau dibatalkan pemanggil (server SMTP lambat/macet). */
  holdNext(): MailHold {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let start!: (signal: AbortSignal | undefined) => void;
    const started = new Promise<AbortSignal | undefined>((resolve) => (start = resolve));
    this.holds.push({ released, start });
    return { release, started };
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
