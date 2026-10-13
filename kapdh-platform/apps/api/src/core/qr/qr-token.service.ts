import { Inject, Injectable } from "@nestjs/common";
import { type ApiEnv, parseSigningKeys, type SigningKey } from "@kapdh/config";
import { compactVerify, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import type { Clock } from "../adapters/clock.js";
import { UUID_PATTERN } from "../validation/validate.js";
import { CLOCK, ENV } from "../tokens.js";

/** Issuer dan audience token QR KTA (ARCHITECTURE §3.2); berbeda dari access token sehingga tidak dapat ditukar. */
export const QR_ISSUER = "kapdh-api";
export const QR_AUDIENCE = "kapdh-kta";
/** Umur token maksimal 7 hari, dibatasi expiry keanggotaan (PRD 3.5, disahkan v3.2). */
export const QR_MAX_TTL_SECONDS = 7 * 24 * 3600;
/** Toleransi jam untuk `iat` dari masa depan (jam server antar-replika). */
const CLOCK_SKEW_SECONDS = 60;

export interface QrTokenClaims {
  /** user_id alumni (identifier internal, bukan prefix nomor; PRD 3.5). */
  userId: string;
  /** N nomor anggota (member_seq). */
  seq: number;
  issuedAt: Date;
  expiresAt: Date;
  keyId: string;
}

export interface SignedQrToken {
  token: string;
  expiresAt: Date;
  keyId: string;
}

/** Hasil {@link QrTokenService.inspect}: klaim token bertanda tangan sah, termasuk yang `exp`-nya sudah lewat. */
export interface InspectedQrToken extends QrTokenClaims {
  /** true bila `exp` <= waktu server (token tidak pernah boleh menghasilkan status Aktif, AC F06-3). */
  expired: boolean;
}

/** N dari nomor AA.SS.JK.N (segmen terakhir), atau null bila bentuknya tidak valid. */
export function memberSeqOf(memberNumber: string): number | null {
  const match = /^\d{2}\.\d{2}\.\d{2}\.([1-9]\d{0,15})$/.exec(memberNumber);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * Keterikatan token pada anggota (kontrak verifyKta langkah 3; AC F05-6, F06-3): `sub` = user_id anggota, `seq` = N
 * anggota di database, DAN nomor pada request (`member_number`, dari URL pemeriksa `/kta/<nomor>`) sama persis dengan
 * nomor TERKINI akun itu. Setelah koreksi identitas oleh pengurus, URL + token lama (prefix lama) atau prefix rekaan
 * menghasilkan false → `invalid_token` ("QR tidak valid atau perlu diperbarui"); kartu berikutnya memuat nomor baru.
 */
export function qrBindingMatches(
  claims: Pick<QrTokenClaims, "userId" | "seq">,
  member: { userId: string; memberSeq: number | null; memberNumber: string | null },
  numberFromRequest: string,
): boolean {
  if (member.memberSeq === null || member.memberNumber === null) return false;
  return (
    claims.userId === member.userId &&
    claims.seq === member.memberSeq &&
    memberSeqOf(member.memberNumber) === member.memberSeq &&
    numberFromRequest === member.memberNumber
  );
}

/**
 * Token QR KTA (PRD 3.5, ARCHITECTURE §3.2): JWT HS256 bertanda tangan kunci PERTAMA `QR_SIGNING_KEYS` (header
 * `kid`), diverifikasi dengan kunci mana pun yang masih terdaftar (rotasi tanpa memutus token lama sampai batasnya).
 * Klaim `iss=kapdh-api`, `aud=kapdh-kta`, `sub=<user_id>`, `seq=<N>`, `iat`, `exp=min(iat+7 hari, expires_at)`.
 * Token tidak memuat kontak atau secret; status keanggotaan SELALU diperiksa ulang dari database saat verifikasi publik
 * (AC F05-4, F06-*). Hanya tersedia di runtime API (secret QR tidak diberikan ke worker).
 */
@Injectable()
export class QrTokenService {
  private readonly keys: SigningKey[];
  private readonly secrets: Map<string, Uint8Array>;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.keys = parseSigningKeys(env.QR_SIGNING_KEYS);
    const encoder = new TextEncoder();
    this.secrets = new Map(this.keys.map((key) => [key.keyId, encoder.encode(key.secret)]));
  }

  /** key_id penanda tangan aktif. */
  get activeKeyId(): string {
    return this.keys[0]!.keyId;
  }

  /**
   * Menandatangani token untuk anggota dengan masa berlaku `membershipExpiresAt`. null bila keanggotaan sudah habis
   * (tidak ada QR aktif untuk kartu yang tidak berlaku).
   */
  async sign(input: {
    userId: string;
    memberSeq: number;
    membershipExpiresAt: Date;
  }): Promise<SignedQrToken | null> {
    if (!UUID_PATTERN.test(input.userId)) throw new Error("userId token QR wajib UUID");
    if (!Number.isSafeInteger(input.memberSeq) || input.memberSeq < 1)
      throw new Error("memberSeq token QR wajib bilangan bulat positif");
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const exp = Math.min(iat + QR_MAX_TTL_SECONDS, Math.floor(input.membershipExpiresAt.getTime() / 1000));
    if (exp <= iat) return null;
    const key = this.keys[0]!;
    const token = await new SignJWT({ seq: input.memberSeq })
      .setProtectedHeader({ alg: "HS256", kid: key.keyId, typ: "JWT" })
      .setIssuer(QR_ISSUER)
      .setAudience(QR_AUDIENCE)
      .setSubject(input.userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.secrets.get(key.keyId)!);
    return { token, expiresAt: new Date(exp * 1000), keyId: key.keyId };
  }

  /**
   * Memeriksa tanda tangan (kid terdaftar, HS256 saja), iss/aud, exp, dan umur (iat tidak dari masa depan, exp - iat
   * <= 7 hari). null untuk token rusak/diubah/kedaluwarsa/kunci yang sudah dicabut (AC F06-3). Keterikatan dan status
   * terkini diperiksa pemanggil (qrBindingMatches + MembershipKernel).
   */
  async verify(token: string): Promise<QrTokenClaims | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "HS256" || typeof header.kid !== "string") return null;
      const secret = this.secrets.get(header.kid);
      if (!secret) return null;
      const now = this.clock.now();
      const { payload } = await jwtVerify(token, secret, {
        issuer: QR_ISSUER,
        audience: QR_AUDIENCE,
        algorithms: ["HS256"],
        currentDate: now,
        requiredClaims: ["sub", "iat", "exp", "seq"],
      });
      const iat = payload.iat!;
      const exp = payload.exp!;
      const seq = payload.seq;
      if (
        typeof payload.sub !== "string" ||
        !UUID_PATTERN.test(payload.sub) ||
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        iat > Math.floor(now.getTime() / 1000) + CLOCK_SKEW_SECONDS ||
        exp - iat > QR_MAX_TTL_SECONDS
      )
        return null;
      return {
        userId: payload.sub,
        seq,
        issuedAt: new Date(iat * 1000),
        expiresAt: new Date(exp * 1000),
        keyId: header.kid,
      };
    } catch {
      return null;
    }
  }

  /**
   * Langkah 1 urutan penilaian kontrak verifyKta (public.yaml): tanda tangan (kid terdaftar, HS256 saja), issuer,
   * audience dan bentuk klaim (sub UUID, seq bilangan bulat positif, iat tidak dari masa depan, 0 < exp - iat <= 7
   * hari) diperiksa, TETAPI `exp` yang sudah lewat tidak ditolak: hasilnya ditandai `expired` agar pemanggil dapat
   * membedakan akun terhapus (`not_found`), token yang dipangkas masa keanggotaan (`expired`) dan token usang
   * (`invalid_token`) tanpa pernah memberi status Aktif (AC F06-2, F06-3, F05-5). null = token rusak/diubah/kunci tidak
   * dikenal → `invalid_token` tanpa membaca data anggota. Klaim tidak pernah dibaca dari token yang belum diverifikasi.
   */
  async inspect(token: string): Promise<InspectedQrToken | null> {
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) return null;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "HS256" || typeof header.kid !== "string") return null;
      if (header.typ !== undefined && header.typ !== "JWT") return null;
      const secret = this.secrets.get(header.kid);
      if (!secret) return null;
      const { payload } = await compactVerify(token, secret, { algorithms: ["HS256"] });
      const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      const { iss, aud, sub, iat, exp, seq } = claims;
      const audienceOk = aud === QR_AUDIENCE || (Array.isArray(aud) && aud.includes(QR_AUDIENCE));
      const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
      if (
        iss !== QR_ISSUER ||
        !audienceOk ||
        typeof sub !== "string" ||
        !UUID_PATTERN.test(sub) ||
        typeof seq !== "number" ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        typeof iat !== "number" ||
        !Number.isSafeInteger(iat) ||
        typeof exp !== "number" ||
        !Number.isSafeInteger(exp) ||
        iat > nowSeconds + CLOCK_SKEW_SECONDS ||
        exp <= iat ||
        exp - iat > QR_MAX_TTL_SECONDS
      )
        return null;
      return {
        userId: sub,
        seq,
        issuedAt: new Date(iat * 1000),
        expiresAt: new Date(exp * 1000),
        keyId: header.kid,
        // Sama dengan aturan jose (`exp <= now` = kedaluwarsa) yang dipakai verify().
        expired: exp <= nowSeconds,
      };
    } catch {
      return null;
    }
  }

  /**
   * Isi QR: `${PUBLIC_WEB_URL}/kta/<nomor>#t=<token>`. Token di fragmen tidak terkirim ke server web, tidak tercatat di
   * access log, dan tidak bocor lewat Referer (PRD 3.6).
   */
  qrContent(memberNumber: string, token: string): string {
    return `${this.env.PUBLIC_WEB_URL}/kta/${encodeURIComponent(memberNumber)}#t=${token}`;
  }
}
