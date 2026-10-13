import { Inject, Injectable } from "@nestjs/common";
import type { BaseEnv } from "@kapdh/config";
import { banners, files, pages, posts } from "@kapdh/database";
import { eq, inArray, or, sql } from "drizzle-orm";
import { AppException, fieldError } from "../../core/errors/app-exception.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { FilePolicies } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import type { FilePurpose } from "../../core/files/purposes.js";
import { ENV } from "../../core/tokens.js";
import { createContentSanitizer, type SanitizedContentHtml } from "./html-sanitizer.js";

/** Purpose gambar konten publik (kontrak C4 `ContentMediaPurpose`). */
export const CONTENT_MEDIA_PURPOSES = ["post_cover", "banner_image"] as const satisfies readonly FilePurpose[];
export type ContentMediaPurpose = (typeof CONTENT_MEDIA_PURPOSES)[number];

/**
 * Gambar konten (PRD 2.5, 3.8, N-10): cover berita, gambar banner, dan gambar di dalam body berita/halaman.
 * - Berkas `post_cover`/`banner_image` bervisibilitas publik (files_private_purpose_chk mengizinkan), sehingga
 *   tampil di aplikasi/situs lewat URL tetap `/files/public/{id}`. Kebijakan akses pengurus `content.manage` tetap
 *   didaftarkan untuk jalur URL bertanda tangan bila suatu saat berkas dijadikan privat.
 * - Berkas yang dipakai objek dilampirkan dalam transaksi yang sama (tidak dibersihkan job `files.cleanup-temp`);
 *   berkas yang tidak dipakai lagi dibuang setelah dipastikan tidak dirujuk konten lain.
 */
@Injectable()
export class ContentMediaService {
  readonly sanitize: (dirty: string) => SanitizedContentHtml;

  constructor(
    private readonly files: FilesService,
    @Inject(ENV) env: BaseEnv,
  ) {
    this.sanitize = createContentSanitizer(env.API_PUBLIC_URL);
    for (const purpose of CONTENT_MEDIA_PURPOSES)
      this.files.registerAccessPolicy(purpose, FilePolicies.adminPermission("content.manage"));
  }

  /** URL publik tetap gambar konten. */
  publicUrl(fileId: string): string {
    return this.files.publicUrl(fileId);
  }

  /**
   * Melampirkan gambar baru (cover/banner) milik pengurus pemanggil di dalam transaksi objek: berkas wajib milik
   * akun login pemanggil, ber-purpose sesuai, siap, dan belum dipakai objek lain (400 pada `field`).
   */
  async attachNew(tx: Tx, fileId: string, uploaderUserId: string, purpose: ContentMediaPurpose, field: string) {
    return this.files.attach(tx, fileId, uploaderUserId, purpose, { field });
  }

  /**
   * Gambar yang dirujuk body (berkas publik KAPDH): wajib ada, siap, publik, dan ber-purpose gambar konten; yang
   * belum terlampir dilampirkan agar tidak dibersihkan job berkas (PRD 2.5). Berkas yang sama boleh dirujuk banyak
   * body. Selain itu 400 VALIDATION_ERROR pada `field`.
   */
  async attachBodyImages(tx: Tx, fileIds: readonly string[], field: string): Promise<void> {
    if (fileIds.length === 0) return;
    const rows = await tx
      .select({
        id: files.id,
        ownerUserId: files.ownerUserId,
        purpose: files.purpose,
        status: files.status,
        visibility: files.visibility,
        attachedAt: files.attachedAt,
      })
      .from(files)
      .where(inArray(files.id, [...fileIds]));
    const invalid = () =>
      fieldError(field, "Gambar di dalam isi harus berupa gambar konten yang diunggah lewat unggah gambar.");
    for (const fileId of fileIds) {
      const row = rows.find((r) => r.id === fileId);
      if (
        !row ||
        row.status !== "ready" ||
        row.visibility !== "public" ||
        !(CONTENT_MEDIA_PURPOSES as readonly string[]).includes(row.purpose) ||
        !row.ownerUserId
      )
        throw invalid();
      if (row.attachedAt) continue;
      try {
        await this.files.attach(tx, row.id, row.ownerUserId, row.purpose as ContentMediaPurpose, { field });
      } catch (error) {
        // Dilampirkan bersamaan oleh konten lain: tetap sah selama berkas masih siap.
        if (!(error instanceof AppException)) throw error;
        const [again] = await tx
          .select({ status: files.status, attachedAt: files.attachedAt })
          .from(files)
          .where(eq(files.id, row.id));
        if (!again || again.status !== "ready" || !again.attachedAt) throw invalid();
      }
    }
  }

  /**
   * Membuang gambar yang dilepas objeknya (ganti cover/gambar banner, hapus berita/banner) bila tidak lagi dirujuk
   * cover/banner lain maupun body berita/halaman (draf atau tayang). Objek storage dihapus setelah commit.
   */
  async discardIfUnreferenced(tx: Tx, fileId: string | null): Promise<void> {
    if (!fileId) return;
    if (await this.isReferenced(tx, fileId)) return;
    await this.files.discard(tx, fileId);
  }

  private async isReferenced(db: DbOrTx, fileId: string): Promise<boolean> {
    const needle = `%/files/public/${fileId}%`;
    const [post] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(or(eq(posts.coverFileId, fileId), sql`${posts.bodyHtml} like ${needle}`))
      .limit(1);
    if (post) return true;
    const [banner] = await db
      .select({ id: banners.id })
      .from(banners)
      .where(eq(banners.imageFileId, fileId))
      .limit(1);
    if (banner) return true;
    const [page] = await db
      .select({ id: pages.id })
      .from(pages)
      .where(or(sql`${pages.bodyHtml} like ${needle}`, sql`${pages.publishedBodyHtml} like ${needle}`))
      .limit(1);
    return Boolean(page);
  }
}
