import { Module } from "@nestjs/common";
import { ContentJobsModule } from "./content-jobs.module.js";

/**
 * F-08 (ARCHITECTURE §4.1): beranda, berita, like, banner, halaman, kategori (anggota + admin + halaman publik),
 * job content.announce. like_count dipelihara trigger (jangan ditulis). Diisi agen modul content (Tahap C).
 */
@Module({ imports: [ContentJobsModule] })
export class ContentModule {}
