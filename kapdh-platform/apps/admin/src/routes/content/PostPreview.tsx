import { Heart, Smartphone } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { formatDate } from "../../lib/format";
import type { ContentImage } from "./contentApi";
import { HtmlPreview } from "./HtmlPreview";

export interface PostPreviewData {
  title: string;
  excerpt: string;
  categoryLabel: string | null;
  cover: ContentImage | null;
  bodyHtml: string;
  /** Waktu tayang yang akan dilihat anggota; null bila belum terbit (ditampilkan "Belum terbit"). */
  publishedAt: string | null;
  likeCount: number;
}

/**
 * Pratinjau berita seperti halaman detail di aplikasi anggota (F-08): cover, kategori, judul, tanggal, ringkasan
 * dan isi. Isi dibangun ulang dari daftar izin (HtmlPreview) sehingga sama amannya dengan hasil sanitasi server;
 * tampilan akhir tetap mengikuti sanitasi server saat disimpan (PRD 3.8).
 */
export function PostPreviewDialog({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: PostPreviewData;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Pratinjau berita"
      description={
        <span className="inline-flex items-center gap-1.5">
          <Smartphone aria-hidden="true" className="size-4" />
          Perkiraan tampilan di aplikasi anggota. Isi akhir mengikuti sanitasi server.
        </span>
      }
      footer={
        <Button variant="outline" onClick={onClose}>
          Tutup pratinjau
        </Button>
      }
    >
      <article
        aria-label={`Pratinjau ${data.title || "berita tanpa judul"}`}
        className="mx-auto flex w-full max-w-[390px] flex-col gap-3 rounded-xl border border-divider bg-surface p-4 shadow-card"
      >
        {data.cover ? (
          <img
            src={data.cover.url}
            alt={`Cover ${data.title}`}
            referrerPolicy="no-referrer"
            className="aspect-video w-full rounded-md bg-neutral-100 object-cover"
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          {data.categoryLabel ? (
            <span className="rounded-pill bg-green-100 px-2.5 py-0.5 font-semibold text-primary">
              {data.categoryLabel}
            </span>
          ) : null}
          <span>{data.publishedAt ? formatDate(data.publishedAt) : "Belum terbit"}</span>
          <span className="inline-flex items-center gap-1">
            <Heart aria-hidden="true" className="size-3.5" />
            {data.likeCount} suka
          </span>
        </div>
        <h3 className="font-heading text-h2 font-semibold leading-tight text-text">
          {data.title || "(Judul belum diisi)"}
        </h3>
        {data.excerpt ? <p className="text-sm font-medium text-text-muted">{data.excerpt}</p> : null}
        <HtmlPreview html={data.bodyHtml} />
      </article>
    </Dialog>
  );
}
