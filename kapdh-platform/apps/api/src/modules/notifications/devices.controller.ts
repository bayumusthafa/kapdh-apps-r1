import { Body, Controller, HttpCode, Post, Put } from "@nestjs/common";
import { z } from "zod";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, MemberAccess } from "../../core/guards/decorators.js";
import { validate } from "../../core/validation/validate.js";
import { DevicesService } from "./devices.service.js";

/** Token FCM: tidak kosong, tanpa spasi/karakter kontrol, <= 4096 (kontrak RegisterDeviceRequest.token). */
const tokenSchema = z
  .string({ message: "Token perangkat wajib diisi" })
  .min(1, "Token perangkat wajib diisi")
  .max(4096, "Token perangkat terlalu panjang")
  .regex(/^[^\s\p{Cc}]+$/u, "Token perangkat tidak valid");

const registerSchema = z
  .object({
    platform: z.enum(["android", "ios"], { message: "Platform harus android atau ios" }),
    token: tokenSchema,
    app_version: z
      .string()
      .max(32, "Versi aplikasi terlalu panjang")
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/, "Versi aplikasi harus semver, mis. 1.0.0")
      .optional(),
  })
  .strict();

const unregisterSchema = z.object({ token: tokenSchema }).strict();

/**
 * Token perangkat FCM (F-13, AC F13-4, F13-5; kontrak notifications.yaml). Token dikirim di body (tidak pernah di path)
 * agar tidak tercatat log akses, dan tidak pernah dikembalikan API maupun dicatat audit (ARCHITECTURE §2 butir 3).
 */
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** registerDevice: diikat ke pengguna dan KELUARGA sesi pemanggil; berpindah akun membatalkan pending pemilik lama. */
  @Put()
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("any")
  async register(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    const input = validate(registerSchema, body);
    await this.devices.register(
      { userId: auth.userId, sessionId: auth.sessionId, familyId: auth.familyId },
      { platform: input.platform, token: input.token, appVersion: input.app_version ?? null },
    );
  }

  /** unregisterDevice: hanya token milik pemanggil; token lain diabaikan dengan respons yang sama (N-09). */
  @Post("unregister")
  @HttpCode(204)
  @Audience("mobile")
  @MemberAccess("any")
  async unregister(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    const input = validate(unregisterSchema, body);
    await this.devices.unregister(auth.userId, input.token);
  }
}
