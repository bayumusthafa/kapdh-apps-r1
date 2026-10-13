import { Body, Controller, Header, HttpCode, Post } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { z } from "zod";
import { Public } from "../../core/guards/decorators.js";
import { validate } from "../../core/validation/validate.js";
import { KtaVerifyService } from "./kta-verify.service.js";

type KtaVerification = components["schemas"]["KtaVerification"];

/** Pola MemberNumber kontrak me.yaml (sama persis dengan skema permintaan). */
const CONTRACT_MEMBER_NUMBER = /^[0-9]{2}\.0[1-3]\.0[12]\.[1-9][0-9]*$/;

/** KtaVerifyRequest (kontrak public.yaml): nomor berpola AA.SS.JK.N dan token 16..2048 karakter; field lain ditolak. */
const ktaVerifySchema = z
  .object({
    member_number: z.string().regex(CONTRACT_MEMBER_NUMBER, "Nomor anggota tidak valid"),
    token: z.string().min(16, "Token QR tidak valid").max(2048, "Token QR tidak valid"),
  })
  .strict();

/**
 * POST /public/kta/verify (F-06): dipanggil shell situs /kta/{nomor} dengan token dari fragmen URL. Publik tanpa
 * autentikasi; dikecualikan dari maintenance per path (core RequestGate). Respons tidak dicache (status terkini).
 */
@Controller("public/kta")
export class KtaVerifyController {
  constructor(private readonly verifier: KtaVerifyService) {}

  @Post("verify")
  @HttpCode(200)
  @Public()
  @Header("cache-control", "no-store")
  verify(@Body() body: unknown): Promise<KtaVerification> {
    return this.verifier.verify(validate(ktaVerifySchema, body));
  }
}
