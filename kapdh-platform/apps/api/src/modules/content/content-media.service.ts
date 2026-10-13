import { Inject, Injectable } from "@nestjs/common";
import type { BaseEnv } from "@kapdh/config";
import { banners, files, pages, posts } from "@kapdh/database";
import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { fieldError } from "../../core/errors/app-exception.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";
import { FilePolicies } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import type { FilePurpose } from "../../core/files/purposes.js";
import { ENV } from "../../core/tokens.js";
import { CONTENT_BODY_HTML_MAX } from "./content.util.js";
import { createContentSanitizer, type SanitizedContentHtml } from "./html-sanitizer.js";

/** Purpose gambar konten publik (kontrak C4 `ContentMediaPurpose`). */
export const CONTENT_MEDIA_PURPOSES = [
  "post_cover",
  "banner_image",
] as const satisfies readonly FilePurpose[];
export type ContentMediaPurpose = (typeof CONTENT_MEDIA_PURPOSES)[number];

/** Baris berkas yang dikunci operasi konten. */
interface LockedFile {
  id: string;
  ownerUserId: string | null;
  purpose: string;
  status: string;
  visibility: string;
  attachedAt: Date | null;
}

const BODY_TOO_LONG =
  "Isi terlalu panjang setelah dibersihkan (maksimal 200.000 karakter). Tautan luar dan karakter khusus " +
  "seperti & atau < menambah panjang; persingkat isi.";

/**
 * Gambar konten (PRD 2.5, 3.8, N-10): cover berita, gambar banner, dan gambar di dalam body berita/halaman.
 * - Berkas `post_cover`/`banner_image` bervisibilitas publik (files_private_purpose_chk mengizinkan), sehingga
 *   tampil di aplikasi/situs lewat URL tetap `/files/public/{id}`. Kebijakan akses pengurus `content.manage` tetap
 *   didaftarkan untuk jalur URL bertanda tangan bila suatu saat berkas dijadikan privat.
 * - Berkas yang dipakai objek dilampirkan dalam transaksi yang sama (tidak dibersihkan job `files.cleanup-temp`);
 *   berkas yang tidak dipakai lagi dibuang setelah dipastikan tidak dirujuk konten lain.
 *
 * Konkurensi (ARCHITECTURE §2): setiap operasi konten yang melampirkan, merujuk, atau membuang gambar lebih dahulu
 * mengunci baris berkas yang disentuhnya dengan FOR NO KEY UPDATE dalam urutan id naik ({@link lockFiles}), sesudah
 * baris kontennya sendiri. Akibatnya:
 * - simpan konten yang merujuk gambar dan pembuangan gambar yang sama berlangsung berurutan: pembuang memeriksa
 *   rujukan sesudah penyimpan commit (gambar dipertahankan), atau penyimpan membaca berkas `deleted` dan ditolak
 *   400; tidak pernah ada konten tersimpan yang menunjuk gambar terhapus;
 * - dua penyimpanan yang merujuk gambar yang sama dalam urutan berbeda tidak saling deadlock;
 * - kunci FK (FOR KEY SHARE) dari baris konten yang menunjuk berkas tidak terhalang.
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
   * Sanitasi body berita/halaman (PRD 3.8) dengan batas isi: kosong setelah sanitasi -> 400 `emptyMessage`; hasil
   * sanitasi lebih dari {@link CONTENT_BODY_HTML_MAX} karakter -> 400 (field `body_html`).
   */
  sanitizeBody(dirty: string, emptyMessage: string): SanitizedContentHtml {
    const body = this.sanitize(dirty);
    if (!body.hasContent) throw fieldError("body_html", emptyMessage);
    if (body.html.length > CONTENT_BODY_HTML_MAX) throw fieldError("body_html", BODY_TOO_LONG);
    return body;
  }

  /**
   * Mengunci baris berkas (FOR NO KEY UPDATE, urut id naik, satu pernyataan) dan mengembalikan keadaan terbarunya.
   * Id kosong/duplikat diabaikan; berkas yang tidak ada tidak muncul di hasil. Panggil sesudah mengunci baris konten
   * dan SEBELUM melampirkan/membuang, dengan SEMUA berkas yang akan disentuh operasi itu.
   */
  async lockFiles(tx: Tx, fileIds: Iterable<string | null | undefined>): Promise<Map<string, LockedFile>> {
    const ids = [...new Set([...fileIds].filter((id): id is string => Boolean(id)))].sort();
    if (ids.length === 0) return new Map();
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
      .where(inArray(files.id, ids))
      .orderBy(asc(files.id))
      .for("no key update");
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * Melampirkan gambar baru (cover/banner) milik pengurus pemanggil di dalam transaksi objek: berkas wajib milik
   * akun login pemanggil, ber-purpose sesuai, siap, dan belum dipakai objek lain (400 pada `field`).
   */
  async attachNew(
    tx: Tx,
    fileId: string,
    uploaderUserId: string,
    purpose: ContentMediaPurpose,
    field: string,
  ) {
    return this.files.attach(tx, fileId, uploaderUserId, purpose, { field });
  }

  /**
   * Gambar yang dirujuk body (berkas publik KAPDH): wajib ada, siap, publik, dan ber-purpose gambar konten; yang
   * belum terlampir dilampirkan agar tidak dibersihkan job berkas (PRD 2.5). Berkas yang sama boleh dirujuk banyak
   * body. Selain itu 400 VALIDATION_ERROR pada `field`. Semua berkas yang dirujuk dikunci (urut id) sebelum
   * diperiksa, termasuk yang sudah terlampir, sehingga pembuangan bersamaan menunggu commit penyimpanan ini.
   */
  async attachBodyImages(tx: Tx, fileIds: readonly string[], field: string): Promise<void> {
    if (fileIds.length === 0) return;
    const locked = await this.lockFiles(tx, fileIds);
    const invalid = () =>
      fieldError(field, "Gambar di dalam isi harus berupa gambar konten yang diunggah lewat unggah gambar.");
    for (const fileId of fileIds) {
      const row = locked.get(fileId);
      if (
        !row ||
        row.status !== "ready" ||
        row.visibility !== "public" ||
        !(CONTENT_MEDIA_PURPOSES as readonly string[]).includes(row.purpose) ||
        !row.ownerUserId
      )
        throw invalid();
      if (row.attachedAt) continue;
      // Baris terkunci transaksi ini: keadaan yang dibaca di atas tidak dapat berubah sebelum UPDATE ini.
      await this.files.attach(tx, row.id, row.ownerUserId, row.purpose as ContentMediaPurpose, { field });
    }
  }

  /**
   * Membuang gambar yang dilepas objeknya (ganti cover/gambar banner, hapus berita/banner) bila tidak lagi dirujuk
   * cover/banner lain maupun body berita/halaman (draf atau tayang). Baris berkas dikunci lebih dahulu sehingga
   * pemeriksaan rujukan melihat setiap penyimpanan yang merujuknya dan sudah commit. Objek storage dihapus setelah
   * commit.
   */
  async discardIfUnreferenced(tx: Tx, fileId: string | null): Promise<void> {
    if (!fileId) return;
    const locked = await this.lockFiles(tx, [fileId]);
    const row = locked.get(fileId);
    if (!row || row.status === "deleted") return;
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
