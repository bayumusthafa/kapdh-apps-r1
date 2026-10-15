import { Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { components } from "@kapdh/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { FilesService } from "../../core/files/files.service.js";
import { receiveSingleImage } from "../../core/files/multipart-upload.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { Audience, CurrentAuth, RequirePermission } from "../../core/guards/decorators.js";
import type { MultipartRouteConfig } from "../../core/http/fastify-hooks.js";

type AdminPaymentQrImage = components["schemas"]["AdminPaymentQrImage"];

/**
 * POST /admin/payment-qr-images (kontrak adminUploadPaymentQrImage; ADR-026, N-10, PRD 2.5): gambar QRIS statis resmi
 * organisasi (`payment_qr`) oleh pengurus settings.manage, untuk dirujuk `qr_image_file_id` metode bayar qris. Hak
 * unggah, batas percobaan dan kuota (10 per akun per 24 jam) diperiksa SEBELUM isi dibaca; isi hanya PNG/JPG, sisi
 * terpendek minimal 512 piksel, EXIF dibuang, di-encode ulang, dan diperkecil bila lebih dari 2048 piksel
 * (FilesService + aturan purpose). Berkas publik; yang tidak dilampirkan ke metode dalam 24 jam dibersihkan job.
 * Tanpa reautentikasi (ADR-025) dan tanpa Idempotency-Key: setiap unggahan membuat berkas baru yang belum terlampir.
 */
@Controller("admin/payment-qr-images")
export class AdminPaymentQrImagesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @HttpCode(201)
  @Audience("admin")
  @RequirePermission("settings.manage")
  @RouteConfig({ multipart: true } satisfies MultipartRouteConfig)
  async upload(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentAuth() auth: AuthContext,
  ): Promise<AdminPaymentQrImage> {
    const { ticket, content } = await receiveSingleImage(
      request,
      reply,
      () => this.files.beginUpload(auth, "payment_qr", { allowed: ["payment_qr"] }),
      "Gambar QRIS wajib dikirim.",
    );
    const file = await this.files.completeUpload(ticket, content);
    return {
      file_id: file.id,
      url: this.files.publicUrl(file.id),
      mime: file.mime as AdminPaymentQrImage["mime"],
      bytes: file.bytes,
      width: file.width ?? 1,
      height: file.height ?? 1,
    };
  }
}
