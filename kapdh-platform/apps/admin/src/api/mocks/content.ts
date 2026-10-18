import type { Permission } from "@kapdh/contracts";
import { mockAdminRef, requirePermission } from "./auth";
import { peekEventForMocks } from "./events";
import {
  error,
  json,
  type MockFile,
  type MockRequest,
  type MockRoute,
  noContent,
  paginate,
  readMultipart,
  type S,
} from "./http";

/**
 * Tiruan Manajemen Konten (F-08, F-15) mengikuti kontrak admin-content final (C4): berita dengan keadaan turunan
 * draft/terjadwal/terbit/arsip, banner dengan target tervalidasi dan jendela tayang, halaman informasi/legal
 * berversi (draf kerja vs salinan tayang), kategori berita (content.manage) serta unggah gambar konten. Kategori event
 * (/admin/content/event-categories, events.manage) ditiru area events (mocks/events.ts) karena dikelola halaman Event &
 * Tiket (guideline p14); baris kategori event di sini hanya untuk kolom Kategori banner bertujuan event. Bukan bukti lulus acceptance criteria (PRD 7.3); aturan nyata ditegakkan modul API content.
 *
 * Aturan server yang ditiru:
 * - Pembaruan, transisi dan penghapusan wajib If-Match; versi lama -> 409 VERSION_CONFLICT dengan `current`
 *   (AC F15-4). Transisi yang tidak sah dari keadaan terkini juga VERSION_CONFLICT.
 * - Konflik yang tidak selesai dengan muat ulang (slug dipakai, kategori dipakai, halaman baku, tidak ada perubahan,
 *   berita yang pernah tampil dijadwalkan ulang) -> 409 VALIDATION_ERROR dengan `field_errors`.
 * - Invarian waktu terbit (kontrak adminPublishPost): berita yang pernah tampil menyimpan `published_at` pertamanya;
 *   unschedule/archive berita terjadwal mengosongkan `published_at` sehingga job lama tidak pernah menghidupkannya
 *   (AC F15-5). Job pengumuman ditiru saat permintaan dibaca: berita yang sudah waktunya tampil diberi `announced_at`
 *   sekali.
 * - Idempotency-Key yang sama dengan payload sama mengembalikan hasil pertama; payload berbeda -> 409.
 */
type Kind = S["ContentCategoryKind"];
type PostStatus = "draft" | "published" | "archived";
type EventStatus = "draft" | "open" | "closed" | "done" | "cancelled";

interface CategoryRow {
  id: string;
  kind: Kind;
  slug: string;
  label: string;
  sort_order: number;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MediaRow {
  file_id: string;
  purpose: S["ContentMediaPurpose"];
  url: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

interface PostRow {
  id: string;
  slug: string;
  title: string;
  status: PostStatus;
  published_at: string | null;
  announced_at: string | null;
  category_id: string | null;
  cover_file_id: string | null;
  excerpt: string | null;
  body_html: string;
  like_count: number;
  version: number;
  created_at: string;
  updated_at: string;
  author: S["AdminContentActor"] | null;
}

interface BannerRow {
  id: string;
  title: string;
  image_file_id: string;
  target_type: S["BannerTargetType"];
  target_value: string | null;
  sort_order: number;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

interface PublishedCopy {
  title: string;
  body_html: string;
  version: number;
  published_at: string;
}

interface PageRow {
  id: string;
  slug: string;
  legal_document: S["PageLegalDocument"] | null;
  system: boolean;
  /** Urutan halaman baku dari seed referensi (PRD 8.2); null untuk halaman tambahan. */
  seed_order: number | null;
  title: string;
  body_html: string;
  published: PublishedCopy | null;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: S["AdminContentActor"] | null;
}

/** Event minimal untuk menyelesaikan target banner dan jumlah pemakaian kategori event (modul events). */
interface EventRow {
  id: string;
  title: string;
  category_id: string | null;
  status: EventStatus;
}

const DAY = 86_400_000;
const IMAGE_MAX = 5 * 1024 * 1024;
const UPLOADS_PER_PURPOSE = 10;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EDITOR: S["AdminContentActor"] = {
  admin_id: "0199e000-0000-7000-8000-0000000000ae",
  display_name: "Nur Hidayah",
};

/** Id contoh yang dipakai uji (src/routes/content/*.test.tsx). */
export const CONTENT_IDS = {
  categoryPengumuman: "0199e100-0000-7000-8000-000000000401",
  categoryEventBulanan: "0199e100-0000-7000-8000-000000000402",
  categoryPromo: "0199e100-0000-7000-8000-000000000403",
  categoryKegiatan: "0199e100-0000-7000-8000-000000000404",
  categoryArsipLama: "0199e100-0000-7000-8000-000000000405",
  categoryReuni: "0199e100-0000-7000-8000-000000000501",
  categorySeminar: "0199e100-0000-7000-8000-000000000502",
  categoryTour: "0199e100-0000-7000-8000-000000000503",
  categoryKemerdekaan: "0199e100-0000-7000-8000-000000000504",
  postDonasi: "0199e100-0000-7000-8000-000000000101",
  postBulanSuci: "0199e100-0000-7000-8000-000000000102",
  postHalalBiHalal: "0199e100-0000-7000-8000-000000000103",
  postDraft: "0199e100-0000-7000-8000-000000000104",
  postScheduled: "0199e100-0000-7000-8000-000000000105",
  postArchived: "0199e100-0000-7000-8000-000000000106",
  postRestored: "0199e100-0000-7000-8000-000000000107",
  bannerDonasi: "0199e100-0000-7000-8000-000000000201",
  bannerHalal: "0199e100-0000-7000-8000-000000000202",
  bannerArsip: "0199e100-0000-7000-8000-000000000203",
  bannerSitus: "0199e100-0000-7000-8000-000000000204",
  bannerBantuan: "0199e100-0000-7000-8000-000000000205",
  pagePrivasi: "0199e100-0000-7000-8000-000000000301",
  pageKetentuan: "0199e100-0000-7000-8000-000000000302",
  pageKomunitas: "0199e100-0000-7000-8000-000000000303",
  pageBantuan: "0199e100-0000-7000-8000-000000000304",
  pageTentang: "0199e100-0000-7000-8000-000000000305",
  pagePanduan: "0199e100-0000-7000-8000-000000000306",
  eventReuni: "0199e100-0000-7000-8000-000000000601",
  eventSeminar: "0199e100-0000-7000-8000-000000000602",
  eventDraft: "0199e100-0000-7000-8000-000000000603",
} as const;
const ID = CONTENT_IDS;

function placeholderImage(label: string, fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="${fill}"/><text x="320" y="180" font-family="Poppins, sans-serif" font-size="28" text-anchor="middle" fill="#FFFFFF">${label}</text><text x="320" y="220" font-family="Poppins, sans-serif" font-size="16" text-anchor="middle" fill="#E6D312">Data contoh mode mock</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let categories = new Map<string, CategoryRow>();
let media = new Map<string, MediaRow>();
let posts = new Map<string, PostRow>();
let banners = new Map<string, BannerRow>();
let pages = new Map<string, PageRow>();
let events = new Map<string, EventRow>();
let seq = 0;
const uploads = new Map<string, number>();
const replays = new Map<string, { payload: string; status: number; body: unknown }>();

/** Gerbang uji: permintaan ditahan sampai dilepas agar keadaan "sedang berjalan" dapat diuji (lihat mockContent). */
interface Gate {
  promise: Promise<void>;
  release: () => void;
  fail: boolean;
}
let uploadGate: Gate | null = null;
let categoryListGate: Gate | null = null;

function gate(fail: boolean): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, fail };
}

export interface ContentRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch: string | null;
  idempotencyKey: string | null;
  background: boolean;
  body: Record<string, unknown> | null;
}

/** Log permintaan ke endpoint konten tiruan, untuk uji (If-Match, Idempotency-Key, field yang dikirim). */
export const contentRequests: ContentRequestLog[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  seq += 1;
  return `0199e100-0000-7000-9000-${String(seq).padStart(12, "0")}`;
}

function category(
  id: string,
  kind: Kind,
  slug: string,
  label: string,
  sortOrder: number,
  active = true,
): CategoryRow {
  const at = "2026-07-01T02:00:00Z";
  return { id, kind, slug, label, sort_order: sortOrder, active, version: 1, created_at: at, updated_at: at };
}

function mediaRow(fileId: string, purpose: S["ContentMediaPurpose"], label: string, fill: string): MediaRow {
  return {
    file_id: fileId,
    purpose,
    url: placeholderImage(label, fill),
    mime: "image/jpeg",
    bytes: 182_000,
    width: 1280,
    height: 720,
  };
}

function post(spec: Partial<PostRow> & Pick<PostRow, "id" | "slug" | "title" | "status">): PostRow {
  const at = spec.created_at ?? "2026-07-20T03:00:00Z";
  return {
    published_at: null,
    announced_at: null,
    category_id: null,
    cover_file_id: null,
    excerpt: null,
    body_html: `<p>${spec.title}: isi berita contoh untuk mode mock.</p>`,
    like_count: 0,
    version: 1,
    created_at: at,
    updated_at: at,
    author: EDITOR,
    ...spec,
  };
}

function page(spec: Partial<PageRow> & Pick<PageRow, "id" | "slug" | "title">): PageRow {
  const at = "2026-07-01T02:00:00Z";
  return {
    legal_document: null,
    system: false,
    seed_order: null,
    body_html: `<p>${spec.title} - isi contoh.</p>`,
    published: null,
    version: 1,
    created_at: at,
    updated_at: at,
    updated_by: EDITOR,
    ...spec,
  };
}

export function reset(): void {
  contentRequests.length = 0;
  uploadGate?.release();
  uploadGate = null;
  categoryListGate?.release();
  categoryListGate = null;
  replays.clear();
  uploads.clear();
  seq = 0;
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();

  categories = new Map(
    [
      category(ID.categoryPengumuman, "post", "pengumuman", "Pengumuman", 0),
      category(ID.categoryEventBulanan, "post", "event-bulanan", "Event Bulanan", 1),
      category(ID.categoryPromo, "post", "promo-spesial", "Promo Spesial", 2),
      category(ID.categoryKegiatan, "post", "kegiatan-alumni", "Kegiatan Alumni", 3),
      category(ID.categoryArsipLama, "post", "arsip-lama", "Arsip Lama", 9, false),
      category(ID.categoryReuni, "event", "reuni", "Reuni", 0),
      category(ID.categorySeminar, "event", "seminar", "Seminar", 1),
      category(ID.categoryTour, "event", "tour", "Tour", 2),
      category(ID.categoryKemerdekaan, "event", "hari-kemerdekaan", "Hari Kemerdekaan", 3),
    ].map((c) => [c.id, c]),
  );

  const coverDonasi = "0199e100-0000-7000-8000-000000000701";
  const coverBulanSuci = "0199e100-0000-7000-8000-000000000702";
  const coverHalal = "0199e100-0000-7000-8000-000000000703";
  const bannerImages = [
    "0199e100-0000-7000-8000-000000000711",
    "0199e100-0000-7000-8000-000000000712",
    "0199e100-0000-7000-8000-000000000713",
    "0199e100-0000-7000-8000-000000000714",
    "0199e100-0000-7000-8000-000000000715",
  ] as const;
  media = new Map(
    [
      mediaRow(coverDonasi, "post_cover", "Donasi korban bencana", "#1A4B17"),
      mediaRow(coverBulanSuci, "post_cover", "Rayakan bulan suci", "#0E280C"),
      mediaRow(coverHalal, "post_cover", "Halal bi Halal", "#2E6B28"),
      mediaRow(bannerImages[0], "banner_image", "Banner donasi", "#1A4B17"),
      mediaRow(bannerImages[1], "banner_image", "Banner halal bi halal", "#2E6B28"),
      mediaRow(bannerImages[2], "banner_image", "Banner bulan suci", "#0E280C"),
      mediaRow(bannerImages[3], "banner_image", "Banner situs resmi", "#1A4B17"),
      mediaRow(bannerImages[4], "banner_image", "Banner bantuan", "#2E6B28"),
    ].map((m) => [m.file_id, m]),
  );

  const base: PostRow[] = [
    post({
      id: ID.postDonasi,
      slug: "donasi-korban-bencana",
      title: "Donasi korban bencana",
      status: "published",
      published_at: "2026-08-03T02:00:00Z",
      announced_at: "2026-08-03T02:00:30Z",
      category_id: ID.categoryEventBulanan,
      cover_file_id: coverDonasi,
      excerpt: "Salurkan bantuan untuk saudara kita yang terdampak bencana.",
      body_html:
        '<p>KAPDH membuka donasi untuk korban bencana. Informasi lengkap di <a href="https://kapdh.or.id/donasi" target="_blank" rel="noopener noreferrer nofollow">situs resmi</a>.</p>',
      like_count: 42,
      created_at: "2026-08-01T02:00:00Z",
      updated_at: "2026-08-03T02:00:00Z",
    }),
    post({
      id: ID.postBulanSuci,
      slug: "rayakan-bulan-suci",
      title: "Rayakan bulan suci",
      status: "published",
      published_at: "2026-08-03T01:00:00Z",
      announced_at: "2026-08-03T01:00:30Z",
      category_id: ID.categoryEventBulanan,
      cover_file_id: coverBulanSuci,
      like_count: 18,
      created_at: "2026-08-02T02:00:00Z",
      updated_at: "2026-08-03T01:00:00Z",
    }),
    post({
      id: ID.postHalalBiHalal,
      slug: "halal-bi-halal",
      title: "Halal bi Halal",
      status: "published",
      published_at: "2026-01-01T02:00:00Z",
      announced_at: "2026-01-01T02:00:30Z",
      category_id: ID.categoryPromo,
      cover_file_id: coverHalal,
      like_count: 7,
      created_at: "2025-12-28T02:00:00Z",
      updated_at: "2026-01-01T02:00:00Z",
    }),
    post({
      id: ID.postDraft,
      slug: "rapat-pengurus-oktober",
      title: "Rapat pengurus Oktober",
      status: "draft",
      category_id: ID.categoryPengumuman,
      excerpt: null,
      created_at: iso(-2 * DAY),
      updated_at: iso(-DAY),
    }),
    post({
      id: ID.postScheduled,
      slug: "reuni-akbar-2026",
      title: "Reuni Akbar 2026",
      status: "published",
      published_at: iso(3 * DAY),
      category_id: ID.categoryKegiatan,
      created_at: iso(-3 * DAY),
      updated_at: iso(-3 * DAY),
    }),
    post({
      id: ID.postArchived,
      slug: "pendaftaran-beasiswa-2025",
      title: "Pendaftaran beasiswa 2025",
      status: "archived",
      published_at: "2025-03-01T02:00:00Z",
      announced_at: "2025-03-01T02:00:30Z",
      category_id: ID.categoryArsipLama,
      like_count: 3,
      created_at: "2025-02-20T02:00:00Z",
      updated_at: "2025-12-01T02:00:00Z",
    }),
    // Draf hasil restore yang pernah tampil: slug terkunci, hanya dapat terbit ulang sekarang.
    post({
      id: ID.postRestored,
      slug: "jadwal-kajian-rutin",
      title: "Jadwal kajian rutin",
      status: "draft",
      published_at: "2026-05-10T02:00:00Z",
      announced_at: "2026-05-10T02:00:30Z",
      category_id: ID.categoryPengumuman,
      like_count: 5,
      created_at: "2026-05-01T02:00:00Z",
      updated_at: iso(-4 * DAY),
    }),
  ];
  // Data sintetis agar paging kursor dapat dicoba (lebih lama dari data prototipe).
  for (let i = 1; i <= 18; i += 1) {
    const n = String(i).padStart(2, "0");
    const at = new Date(Date.UTC(2026, 3, i, 2, 0)).toISOString();
    base.push(
      post({
        id: `0199e100-0000-7000-8000-0000000011${n}`,
        slug: `kabar-alumni-${n}`,
        title: `Kabar alumni ${n}`,
        status: "published",
        published_at: at,
        announced_at: at,
        category_id: ID.categoryPengumuman,
        created_at: at,
        updated_at: at,
      }),
    );
  }
  posts = new Map(base.map((p) => [p.id, p]));

  events = new Map(
    [
      { id: ID.eventReuni, title: "Reuni Akbar", category_id: ID.categoryReuni, status: "open" as const },
      {
        id: ID.eventSeminar,
        title: "Seminar Karier Alumni",
        category_id: ID.categorySeminar,
        status: "cancelled" as const,
      },
      {
        id: ID.eventDraft,
        title: "Pramuka bersama",
        category_id: ID.categorySeminar,
        status: "draft" as const,
      },
    ].map((e) => [e.id, e]),
  );

  const banner = (
    spec: Partial<BannerRow> & Pick<BannerRow, "id" | "title" | "image_file_id">,
  ): BannerRow => ({
    target_type: "none",
    target_value: null,
    sort_order: 0,
    starts_at: "2026-08-01T00:00:00Z",
    ends_at: null,
    active: true,
    version: 1,
    created_at: "2026-07-30T02:00:00Z",
    updated_at: "2026-07-30T02:00:00Z",
    ...spec,
  });
  banners = new Map(
    [
      banner({
        id: ID.bannerDonasi,
        title: "Donasi korban bencana",
        image_file_id: bannerImages[0],
        target_type: "post",
        target_value: ID.postDonasi,
        sort_order: 0,
        starts_at: "2026-08-03T00:00:00Z",
      }),
      banner({
        id: ID.bannerHalal,
        title: "Reuni Akbar",
        image_file_id: bannerImages[1],
        target_type: "event",
        target_value: ID.eventReuni,
        sort_order: 1,
        starts_at: iso(5 * DAY),
        ends_at: iso(20 * DAY),
      }),
      // Target diarsipkan: tetap tayang tetapi tujuan tidak tersedia (AC F08-2).
      banner({
        id: ID.bannerArsip,
        title: "Beasiswa 2025",
        image_file_id: bannerImages[2],
        target_type: "post",
        target_value: ID.postArchived,
        sort_order: 2,
        starts_at: "2025-03-01T00:00:00Z",
      }),
      banner({
        id: ID.bannerSitus,
        title: "Situs resmi KAPDH",
        image_file_id: bannerImages[3],
        target_type: "url",
        target_value: "https://kapdh.or.id",
        sort_order: 3,
        starts_at: "2026-01-01T00:00:00Z",
        ends_at: "2026-02-01T00:00:00Z",
      }),
      banner({
        id: ID.bannerBantuan,
        title: "Pusat bantuan",
        image_file_id: bannerImages[4],
        target_type: "page",
        target_value: "bantuan",
        sort_order: 4,
        active: false,
      }),
    ].map((b) => [b.id, b]),
  );

  pages = new Map(
    [
      page({
        id: ID.pagePrivasi,
        slug: "kebijakan-privasi",
        title: "Kebijakan Privasi",
        legal_document: "privacy",
        system: true,
        seed_order: 0,
        body_html: "<p>Kebijakan privasi KAPDH (draf revisi: penambahan retensi cadangan 30 hari).</p>",
        published: {
          title: "Kebijakan Privasi",
          body_html: "<p>Kebijakan privasi KAPDH.</p>",
          version: 2,
          published_at: "2026-09-01T02:00:00Z",
        },
        version: 5,
      }),
      page({
        id: ID.pageKetentuan,
        slug: "ketentuan",
        title: "Ketentuan Layanan",
        legal_document: "terms",
        system: true,
        seed_order: 1,
        body_html: "<p>Ketentuan layanan KAPDH.</p>",
        published: {
          title: "Ketentuan Layanan",
          body_html: "<p>Ketentuan layanan KAPDH.</p>",
          version: 1,
          published_at: "2026-08-01T02:00:00Z",
        },
        version: 2,
      }),
      page({
        id: ID.pageKomunitas,
        slug: "ketentuan-komunitas",
        title: "Ketentuan Komunitas",
        legal_document: "community",
        system: true,
        seed_order: 2,
        body_html: "<p>Ketentuan komunitas KAPDH.</p>",
        published: {
          title: "Ketentuan Komunitas",
          body_html: "<p>Ketentuan komunitas KAPDH.</p>",
          version: 1,
          published_at: "2026-08-01T02:00:00Z",
        },
        version: 2,
      }),
      page({
        id: ID.pageBantuan,
        slug: "bantuan",
        title: "Bantuan",
        system: true,
        seed_order: 3,
        body_html: "<p>Hubungi bantuan@kapdh.or.id.</p>",
        published: {
          title: "Bantuan",
          body_html: "<p>Hubungi bantuan@kapdh.or.id.</p>",
          version: 1,
          published_at: "2026-08-01T02:00:00Z",
        },
        version: 2,
      }),
      page({
        id: ID.pageTentang,
        slug: "tentang",
        title: "Tentang KAPDH",
        system: true,
        seed_order: 4,
        body_html: "<p>Keluarga Alumni Pesantren Darel Hikmah.</p>",
        published: {
          title: "Tentang KAPDH",
          body_html: "<p>Keluarga Alumni Pesantren Darel Hikmah.</p>",
          version: 1,
          published_at: "2026-08-01T02:00:00Z",
        },
        version: 2,
      }),
      page({
        id: ID.pagePanduan,
        slug: "panduan-iuran",
        title: "Panduan Iuran",
        body_html: "<p>Langkah membayar iuran anggota.</p>",
      }),
    ].map((p) => [p.id, p]),
  );
}
reset();

function log(req: MockRequest): void {
  contentRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    ifMatch: req.headers.get("If-Match"),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    background: req.headers.get("X-Background-Request") === "1",
    body: req.body,
  });
}

/** Tiruan job content.announce: berita yang sudah waktunya tampil diumumkan tepat sekali (AC F15-5). */
function announceDue(): void {
  const now = Date.now();
  for (const p of posts.values()) {
    if (p.status === "published" && p.published_at && Date.parse(p.published_at) <= now && !p.announced_at)
      p.announced_at = nowIso();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Presentasi (bentuk kontrak)
// ---------------------------------------------------------------------------------------------------------------

function categoryRef(id: string | null): S["ContentCategoryRef"] | null {
  const c = id ? categories.get(id) : undefined;
  return c ? { id: c.id, slug: c.slug, label: c.label } : null;
}

function image(fileId: string | null): S["ContentImage"] | null {
  const m = fileId ? media.get(fileId) : undefined;
  return m ? { file_id: m.file_id, url: m.url } : null;
}

function isVisible(p: PostRow, now = Date.now()): boolean {
  return p.published_at !== null && Date.parse(p.published_at) <= now;
}

function postState(p: PostRow): S["AdminPostState"] {
  if (p.status === "draft") return "draft";
  if (p.status === "archived") return "archived";
  return isVisible(p) ? "published" : "scheduled";
}

function postSummary(p: PostRow): S["AdminPostSummary"] {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    state: postState(p),
    category: categoryRef(p.category_id),
    cover: image(p.cover_file_id),
    published_at: p.published_at,
    like_count: p.like_count,
    version: String(p.version),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function postDetail(p: PostRow): S["AdminPost"] {
  return {
    ...postSummary(p),
    excerpt: p.excerpt,
    body_html: p.body_html,
    announced_at: p.announced_at,
    slug_locked: isVisible(p),
    author: p.author,
  };
}

/**
 * Event tujuan banner: data contoh area ini lebih dahulu (uji konten memakai CONTENT_IDS.event*), lalu event server
 * tiruan area events. Pemilih tujuan mencari lewat GET /admin/events (mocks/events.ts), sehingga event yang dipilih
 * di sana harus lolos validasi dan tampil sebagai tujuan di sini (integrasi Fase C, satu sumber event di dev:mock).
 */
function eventTarget(
  id: string,
): { id: string; title: string; status: EventStatus; category: S["ContentCategoryRef"] | null } | undefined {
  const own = events.get(id);
  if (own)
    return { id: own.id, title: own.title, status: own.status, category: categoryRef(own.category_id) };
  return peekEventForMocks(id);
}

function bannerTarget(b: BannerRow): S["AdminBannerTarget"] {
  const base = { type: b.target_type, value: b.target_value };
  if (b.target_type === "none" || b.target_type === "url")
    return { ...base, available: true, label: null, route: null, category: null };
  if (b.target_type === "post") {
    const p = [...posts.values()].find((x) => x.id === b.target_value);
    if (!p) return { ...base, available: false, label: null, route: null, category: null };
    return {
      ...base,
      available: postState(p) === "published",
      label: p.title,
      route: `/news/${p.slug}`,
      category: categoryRef(p.category_id),
    };
  }
  if (b.target_type === "event") {
    const e = b.target_value ? eventTarget(b.target_value) : undefined;
    if (!e) return { ...base, available: false, label: null, route: null, category: null };
    return {
      ...base,
      available: e.status === "open" || e.status === "closed",
      label: e.title,
      route: `/events/${e.id}`,
      category: e.category,
    };
  }
  const pg = [...pages.values()].find((x) => x.slug === b.target_value);
  if (!pg) return { ...base, available: false, label: null, route: null, category: null };
  return {
    ...base,
    available: pg.published !== null,
    label: pg.published?.title ?? pg.title,
    route: `/legal/${pg.slug}`,
    category: null,
  };
}

function bannerState(b: BannerRow): S["AdminBannerState"] {
  const now = Date.now();
  if (!b.active) return "inactive";
  if (Date.parse(b.starts_at) > now) return "scheduled";
  if (b.ends_at && Date.parse(b.ends_at) <= now) return "ended";
  return "live";
}

function bannerOut(b: BannerRow): S["AdminBanner"] {
  return {
    id: b.id,
    title: b.title,
    image: image(b.image_file_id) ?? { file_id: b.image_file_id, url: placeholderImage("Gambar", "#6B6B6B") },
    target: bannerTarget(b),
    sort_order: b.sort_order,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    active: b.active,
    state: bannerState(b),
    version: String(b.version),
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

function hasUnpublishedChanges(p: PageRow): boolean {
  return p.published === null || p.published.title !== p.title || p.published.body_html !== p.body_html;
}

function pageSummary(p: PageRow): S["AdminInfoPageSummary"] {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    legal_document: p.legal_document,
    system: p.system,
    published_version: p.published ? String(p.published.version) : null,
    published_at: p.published?.published_at ?? null,
    has_unpublished_changes: hasUnpublishedChanges(p),
    version: String(p.version),
    updated_at: p.updated_at,
    updated_by: p.updated_by,
  };
}

function pageDetail(p: PageRow): S["AdminInfoPage"] {
  return {
    ...pageSummary(p),
    body_html: p.body_html,
    published: p.published
      ? {
          title: p.published.title,
          body_html: p.published.body_html,
          version: String(p.published.version),
          published_at: p.published.published_at,
        }
      : null,
    slug_locked: p.system || p.published !== null,
    created_at: p.created_at,
  };
}

/** Jumlah berita yang memakai kategori berita (hanya kategori berita yang dikelola tiruan ini). */
function usageCount(c: CategoryRow): number {
  return [...posts.values()].filter((p) => p.category_id === c.id).length;
}

function categoryOut(c: CategoryRow): S["AdminContentCategory"] {
  return {
    id: c.id,
    kind: c.kind,
    slug: c.slug,
    label: c.label,
    sort_order: c.sort_order,
    active: c.active,
    usage_count: usageCount(c),
    version: String(c.version),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validasi dan bantuan permintaan
// ---------------------------------------------------------------------------------------------------------------

type FieldErrors = Record<string, string[]>;

function invalid(fieldErrors: FieldErrors, status = 400): Response {
  return error(status, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
    field_errors: fieldErrors,
  });
}

function notFound(): Response {
  return error(404, "NOT_FOUND", "Data tidak ditemukan atau sudah tidak tersedia.");
}

function conflict(current: unknown, message = "Data sudah diubah pengurus lain. Muat ulang."): Response {
  return error(409, "VERSION_CONFLICT", message, { current });
}

/** Path uuid tidak valid -> 400 VALIDATION_ERROR (kontrak admin-content). */
function badId(value: string | undefined, field: string): Response | null {
  return value && UUID.test(value) ? null : invalid({ [field]: ["Id tidak valid."] });
}

/** If-Match wajib; null bila cocok dengan versi baris, selain itu respons 400/409. */
function checkIfMatch(req: MockRequest, version: number, current: () => unknown): Response | null {
  const header = req.headers.get("If-Match");
  if (!header) return invalid({ "If-Match": ["Header If-Match wajib diisi."] });
  if (header !== String(version)) return conflict(current());
  return null;
}

/** Putar ulang hasil berhasil untuk Idempotency-Key yang sama (PRD 4.3). */
function withIdempotency(req: MockRequest, handle: () => Response | Promise<Response>): Promise<Response> {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([req.method, req.path, req.body]);
  const replay = key ? replays.get(key) : undefined;
  if (replay) {
    if (replay.payload !== payload)
      return Promise.resolve(
        error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain."),
      );
    return Promise.resolve(json(replay.status, replay.body));
  }
  return Promise.resolve(handle()).then(async (res) => {
    if (key && res.ok) {
      const text = await res.clone().text();
      replays.set(key, {
        payload,
        status: res.status,
        body: text ? (JSON.parse(text) as unknown) : undefined,
      });
    }
    return res;
  });
}

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function checkText(
  errs: FieldErrors,
  body: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
) {
  const v = body[key];
  if (typeof v !== "string" || v.trim().length < 1) errs[key] = [`${label} wajib diisi.`];
  else if (v.length > max) errs[key] = [`${label} maksimal ${max} karakter.`];
}

function checkSlug(errs: FieldErrors, body: Record<string, unknown>, max: number) {
  const v = body.slug;
  if (typeof v !== "string" || !SLUG.test(v) || v.length > max)
    errs.slug = ["Slug hanya huruf kecil, angka dan tanda hubung, misalnya kabar-alumni."];
}

/** Isi kosong setelah sanitasi ditolak (kontrak AdminPostCreateRequest.body_html). */
function checkBody(errs: FieldErrors, body: Record<string, unknown>) {
  const v = body.body_html;
  if (typeof v !== "string" || v.length > 200_000) {
    errs.body_html = ["Isi wajib diisi."];
    return;
  }
  const text = v
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  if (!text && !/<img\b/i.test(v)) errs.body_html = ["Isi wajib diisi."];
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 150) || "konten"
  );
}

function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  let slug = base;
  for (let n = 2; taken(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

function sortBy<T>(items: T[], compare: (a: T, b: T) => number, id: (t: T) => string): T[] {
  return [...items].sort((a, b) => compare(a, b) || id(a).localeCompare(id(b)));
}

const desc = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b.localeCompare(a);

// ---------------------------------------------------------------------------------------------------------------
// Kategori
// ---------------------------------------------------------------------------------------------------------------

/**
 * Kategori berita (content.manage). /admin/content/event-categories sengaja tidak didaftarkan di sini: router tiruan
 * memakai rute pertama yang cocok dan area dimuat berurutan nama berkas, sehingga rute kategori event di berkas ini
 * akan menutupi tiruan milik area events.
 */
function postCategoryRoutes(): MockRoute[] {
  const kind: Kind = "post";
  const base = "/admin/content/post-categories";
  const permission: Permission = "content.manage";
  const find = (req: MockRequest): CategoryRow | Response => {
    const bad = badId(req.params.categoryId, "categoryId");
    if (bad) return bad;
    const c = categories.get(req.params.categoryId ?? "");
    // Id kategori jenis lain pada path ini -> 404 (kontrak).
    return c && c.kind === kind ? c : notFound();
  };
  const slugTaken = (slug: string, exceptId?: string) =>
    [...categories.values()].some((c) => c.kind === kind && c.slug === slug && c.id !== exceptId);

  function validateFields(body: Record<string, unknown>, partial: boolean): FieldErrors {
    const errs: FieldErrors = {};
    if (!partial || has(body, "label")) checkText(errs, body, "label", "Label", 80);
    if (has(body, "slug")) checkSlug(errs, body, 80);
    if (has(body, "sort_order")) {
      const v = body.sort_order;
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 32767)
        errs.sort_order = ["Urutan berupa angka 0 sampai 32767."];
    }
    if (has(body, "active") && typeof body.active !== "boolean") errs.active = ["Status aktif tidak valid."];
    return errs;
  }

  return [
    {
      method: "GET",
      path: base,
      handler: async (req) => {
        log(req);
        const denied = requirePermission(req, permission);
        if (denied) return denied;
        const held = categoryListGate;
        if (held) {
          categoryListGate = null;
          await held.promise;
          if (held.fail) return error(500, "INTERNAL_ERROR", "Terjadi kesalahan. Coba lagi.");
        }
        const params = req.url.searchParams;
        const q = (params.get("q") ?? "").trim().toLowerCase();
        const active = params.get("active");
        const sort = params.get("sort") ?? "sort_order_asc";
        const rows = [...categories.values()]
          .filter((c) => c.kind === kind)
          .filter((c) => active === null || String(c.active) === active)
          .filter((c) => !q || c.label.toLowerCase().includes(q) || c.slug.includes(q));
        const sorted =
          sort === "label_asc"
            ? sortBy(
                rows,
                (a, b) => a.label.localeCompare(b.label, "id"),
                (c) => c.id,
              )
            : sort === "usage_desc"
              ? sortBy(
                  rows,
                  (a, b) => usageCount(b) - usageCount(a),
                  (c) => c.id,
                )
              : sort === "updated_at_desc"
                ? sortBy(
                    rows,
                    (a, b) => b.updated_at.localeCompare(a.updated_at),
                    (c) => c.id,
                  )
                : sortBy(
                    rows,
                    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label, "id"),
                    (c) => c.id,
                  );
        return json(200, paginate(sorted.map(categoryOut), req.url) satisfies S["AdminContentCategoryPage"]);
      },
    },
    {
      method: "POST",
      path: base,
      handler: (req) => {
        log(req);
        const denied = requirePermission(req, permission);
        if (denied) return denied;
        return withIdempotency(req, () => {
          const body = req.body ?? {};
          const errs = validateFields(body, false);
          if (Object.keys(errs).length > 0) return invalid(errs);
          const label = str(body, "label")!.trim();
          const slug = str(body, "slug") ?? uniqueSlug(slugify(label), (s) => slugTaken(s));
          if (slugTaken(slug)) return invalid({ slug: ["Slug sudah dipakai kategori lain."] }, 409);
          const at = nowIso();
          const row: CategoryRow = {
            id: newId(),
            kind,
            slug,
            label,
            sort_order: (body.sort_order as number | undefined) ?? 0,
            active: (body.active as boolean | undefined) ?? true,
            version: 1,
            created_at: at,
            updated_at: at,
          };
          categories.set(row.id, row);
          return json(201, categoryOut(row));
        });
      },
    },
    {
      method: "GET",
      path: `${base}/{categoryId}`,
      handler: (req) => {
        log(req);
        const denied = requirePermission(req, permission);
        if (denied) return denied;
        const c = find(req);
        return c instanceof Response ? c : json(200, categoryOut(c));
      },
    },
    {
      method: "PATCH",
      path: `${base}/{categoryId}`,
      handler: (req) => {
        log(req);
        const denied = requirePermission(req, permission);
        if (denied) return denied;
        const c = find(req);
        if (c instanceof Response) return c;
        const body = req.body ?? {};
        if (Object.keys(body).length === 0) return invalid({ _: ["Tidak ada perubahan."] });
        const errs = validateFields(body, true);
        if (Object.keys(errs).length > 0) return invalid(errs);
        const stale = checkIfMatch(req, c.version, () => categoryOut(c));
        if (stale) return stale;
        const slug = str(body, "slug");
        if (slug !== undefined && slugTaken(slug, c.id))
          return invalid({ slug: ["Slug sudah dipakai kategori lain."] }, 409);
        const next: CategoryRow = {
          ...c,
          label: str(body, "label")?.trim() ?? c.label,
          slug: slug ?? c.slug,
          sort_order: (body.sort_order as number | undefined) ?? c.sort_order,
          active: (body.active as boolean | undefined) ?? c.active,
          version: c.version + 1,
          updated_at: nowIso(),
        };
        categories.set(c.id, next);
        return json(200, categoryOut(next));
      },
    },
    {
      method: "DELETE",
      path: `${base}/{categoryId}`,
      handler: (req) => {
        log(req);
        const denied = requirePermission(req, permission);
        if (denied) return denied;
        const c = find(req);
        if (c instanceof Response) return c;
        const stale = checkIfMatch(req, c.version, () => categoryOut(c));
        if (stale) return stale;
        // Server: FK RESTRICT (23503/23001), bukan hitungan baca-lalu-hapus.
        if (usageCount(c) > 0)
          return invalid(
            {
              _: [
                `Kategori masih dipakai ${usageCount(c)} berita. Nonaktifkan kategori agar tidak dipilih lagi.`,
              ],
            },
            409,
          );
        categories.delete(c.id);
        return noContent();
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Berita
// ---------------------------------------------------------------------------------------------------------------

function findPost(req: MockRequest): PostRow | Response {
  const bad = badId(req.params.postId, "postId");
  if (bad) return bad;
  return posts.get(req.params.postId ?? "") ?? notFound();
}

function postSlugTaken(slug: string, exceptId?: string): boolean {
  return [...posts.values()].some((p) => p.slug === slug && p.id !== exceptId);
}

function validatePostRefs(errs: FieldErrors, body: Record<string, unknown>, current: PostRow | null): void {
  if (has(body, "cover_file_id") && body.cover_file_id !== null) {
    const m = media.get(String(body.cover_file_id));
    if (!m || m.purpose !== "post_cover")
      errs.cover_file_id = ["Cover harus gambar yang diunggah untuk berita."];
  }
  if (has(body, "category_id") && body.category_id !== null) {
    const c = categories.get(String(body.category_id));
    const keptInactive = current !== null && c !== undefined && current.category_id === c.id;
    if (!c || c.kind !== "post") errs.category_id = ["Kategori berita tidak ditemukan."];
    else if (!c.active && !keptInactive) errs.category_id = ["Kategori nonaktif tidak dapat dipilih."];
  }
}

function updatePost(p: PostRow, patch: Partial<PostRow>): PostRow {
  // `author` adalah pembuat berita (posts.author_admin_id), diisi sekali saat dibuat; tidak berubah saat diperbarui.
  const next = { ...p, ...patch, version: p.version + 1, updated_at: nowIso() };
  posts.set(p.id, next);
  return next;
}

const postRoutes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/content/posts",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      announceDue();
      const params = req.url.searchParams;
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const state = params.get("state");
      const categoryId = params.get("category_id");
      const sort = params.get("sort") ?? "updated_at_desc";
      const rows = [...posts.values()]
        .filter((p) => !state || postState(p) === state)
        .filter((p) => !categoryId || p.category_id === categoryId)
        .filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q));
      const sorted =
        sort === "title_asc"
          ? sortBy(
              rows,
              (a, b) => a.title.localeCompare(b.title, "id"),
              (p) => p.id,
            )
          : sort === "published_at_desc"
            ? sortBy(
                rows,
                (a, b) => desc(a.published_at, b.published_at),
                (p) => p.id,
              )
            : sort === "created_at_desc"
              ? sortBy(
                  rows,
                  (a, b) => b.created_at.localeCompare(a.created_at),
                  (p) => p.id,
                )
              : sortBy(
                  rows,
                  (a, b) => b.updated_at.localeCompare(a.updated_at),
                  (p) => p.id,
                );
      return json(200, paginate(sorted.map(postSummary), req.url) satisfies S["AdminPostPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/content/posts",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        const body = req.body ?? {};
        const errs: FieldErrors = {};
        checkText(errs, body, "title", "Judul", 200);
        if (has(body, "slug")) checkSlug(errs, body, 160);
        if (has(body, "excerpt") && body.excerpt !== null) {
          if (typeof body.excerpt !== "string" || body.excerpt.length > 300)
            errs.excerpt = ["Ringkasan maksimal 300 karakter."];
        }
        checkBody(errs, body);
        validatePostRefs(errs, body, null);
        if (Object.keys(errs).length > 0) return invalid(errs);
        const title = str(body, "title")!.trim();
        const slug = str(body, "slug") ?? uniqueSlug(slugify(title), (s) => postSlugTaken(s));
        if (postSlugTaken(slug)) return invalid({ slug: ["Slug sudah dipakai berita lain."] }, 409);
        const at = nowIso();
        const row = post({
          id: newId(),
          slug,
          title,
          status: "draft",
          excerpt: (body.excerpt as string | null | undefined) ?? null,
          body_html: str(body, "body_html")!,
          cover_file_id: (body.cover_file_id as string | null | undefined) ?? null,
          category_id: (body.category_id as string | null | undefined) ?? null,
          created_at: at,
          updated_at: at,
          author: mockAdminRef(),
        });
        posts.set(row.id, row);
        return json(201, postDetail(row));
      });
    },
  },
  {
    method: "GET",
    path: "/admin/content/posts/{postId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      announceDue();
      const p = findPost(req);
      return p instanceof Response ? p : json(200, postDetail(p));
    },
  },
  {
    method: "PATCH",
    path: "/admin/content/posts/{postId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      announceDue();
      const p = findPost(req);
      if (p instanceof Response) return p;
      const body = req.body ?? {};
      const errs: FieldErrors = {};
      if (Object.keys(body).length === 0) errs._ = ["Tidak ada perubahan untuk disimpan."];
      if (has(body, "title")) checkText(errs, body, "title", "Judul", 200);
      if (has(body, "slug")) checkSlug(errs, body, 160);
      if (has(body, "excerpt") && body.excerpt !== null) {
        if (typeof body.excerpt !== "string" || body.excerpt.length > 300)
          errs.excerpt = ["Ringkasan maksimal 300 karakter."];
      }
      if (has(body, "body_html")) checkBody(errs, body);
      validatePostRefs(errs, body, p);
      if (Object.keys(errs).length > 0) return invalid(errs);
      const stale = checkIfMatch(req, p.version, () => postDetail(p));
      if (stale) return stale;
      const slug = str(body, "slug");
      if (slug !== undefined && slug !== p.slug) {
        if (isVisible(p))
          return invalid({
            slug: ["Slug berita yang pernah tampil tidak dapat diubah agar tautan lama tetap berlaku."],
          });
        if (postSlugTaken(slug, p.id)) return invalid({ slug: ["Slug sudah dipakai berita lain."] }, 409);
      }
      const next = updatePost(p, {
        title: str(body, "title")?.trim() ?? p.title,
        slug: slug ?? p.slug,
        excerpt: has(body, "excerpt") ? ((body.excerpt as string | null) ?? null) : p.excerpt,
        body_html: str(body, "body_html") ?? p.body_html,
        cover_file_id: has(body, "cover_file_id")
          ? ((body.cover_file_id as string | null) ?? null)
          : p.cover_file_id,
        category_id: has(body, "category_id") ? ((body.category_id as string | null) ?? null) : p.category_id,
      });
      return json(200, postDetail(next));
    },
  },
  {
    method: "DELETE",
    path: "/admin/content/posts/{postId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      announceDue();
      const p = findPost(req);
      if (p instanceof Response) return p;
      const stale = checkIfMatch(req, p.version, () => postDetail(p));
      if (stale) return stale;
      const state = postState(p);
      if (state !== "draft" && state !== "archived")
        return conflict(postDetail(p), "Berita yang tampil atau terjadwal harus diarsipkan dahulu.");
      posts.delete(p.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/content/posts/{postId}/publish",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        announceDue();
        const p = findPost(req);
        if (p instanceof Response) return p;
        const body = req.body ?? {};
        const at = body.published_at;
        if (at !== undefined && at !== null && !isIso(at))
          return invalid({ published_at: ["Waktu terbit tidak valid."] });
        const stale = checkIfMatch(req, p.version, () => postDetail(p));
        if (stale) return stale;
        const state = postState(p);
        if (state === "published" || state === "archived")
          return conflict(postDetail(p), "Keadaan berita sudah berubah. Muat ulang.");
        const now = Date.now();
        if (typeof at === "string" && Date.parse(at) <= now)
          return invalid({
            published_at: ["Waktu terbit harus di masa depan. Kosongkan untuk terbit sekarang."],
          });
        if (typeof at === "string" && state === "draft" && isVisible(p, now))
          return invalid(
            {
              published_at: [
                "Berita yang pernah tampil tidak dapat dijadwalkan ulang; terbitkan sekarang dengan tanggal publikasi aslinya.",
              ],
            },
            409,
          );
        const publishedAt =
          typeof at === "string" ? at : state === "draft" && isVisible(p, now) ? p.published_at! : nowIso();
        const next = updatePost(p, { status: "published", published_at: publishedAt });
        announceDue();
        return json(200, postDetail(posts.get(next.id)!));
      });
    },
  },
  {
    method: "POST",
    path: "/admin/content/posts/{postId}/unschedule",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        announceDue();
        const p = findPost(req);
        if (p instanceof Response) return p;
        const stale = checkIfMatch(req, p.version, () => postDetail(p));
        if (stale) return stale;
        if (postState(p) !== "scheduled" || p.announced_at)
          return conflict(postDetail(p), "Berita sudah tampil atau tidak lagi terjadwal. Muat ulang.");
        return json(200, postDetail(updatePost(p, { status: "draft", published_at: null })));
      });
    },
  },
  {
    method: "POST",
    path: "/admin/content/posts/{postId}/archive",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        announceDue();
        const p = findPost(req);
        if (p instanceof Response) return p;
        const stale = checkIfMatch(req, p.version, () => postDetail(p));
        if (stale) return stale;
        if (p.status === "archived") return conflict(postDetail(p), "Berita sudah diarsipkan.");
        const scheduled = p.published_at !== null && Date.parse(p.published_at) > Date.now();
        return json(
          200,
          postDetail(updatePost(p, { status: "archived", published_at: scheduled ? null : p.published_at })),
        );
      });
    },
  },
  {
    method: "POST",
    path: "/admin/content/posts/{postId}/restore",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        const p = findPost(req);
        if (p instanceof Response) return p;
        const stale = checkIfMatch(req, p.version, () => postDetail(p));
        if (stale) return stale;
        if (p.status !== "archived")
          return conflict(postDetail(p), "Hanya berita arsip yang dapat dipulihkan.");
        return json(200, postDetail(updatePost(p, { status: "draft" })));
      });
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------------------------------------------

const TARGET_TYPES: S["BannerTargetType"][] = ["none", "post", "event", "page", "url"];

function validateTarget(errs: FieldErrors, type: unknown, value: unknown): void {
  if (!TARGET_TYPES.includes(type as S["BannerTargetType"])) {
    errs.target_type = ["Jenis tujuan tidak dikenal."];
    return;
  }
  if (type === "none") {
    if (value !== null) errs.target_value = ["Banner tanpa tujuan tidak memiliki nilai tujuan."];
    return;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    errs.target_value = ["Tujuan wajib dipilih."];
    return;
  }
  if (type === "post" && !(UUID.test(value) && posts.has(value)))
    errs.target_value = ["Berita tujuan tidak ditemukan."];
  if (type === "event" && !(UUID.test(value) && eventTarget(value)))
    errs.target_value = ["Event tujuan tidak ditemukan."];
  if (type === "page" && ![...pages.values()].some((p) => p.slug === value))
    errs.target_value = ["Halaman tujuan tidak ditemukan."];
  if (type === "url") {
    let ok = false;
    try {
      ok = new URL(value).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) errs.target_value = ["Tautan luar harus diawali https://."];
  }
}

function validateBanner(body: Record<string, unknown>, current: BannerRow | null): FieldErrors {
  const errs: FieldErrors = {};
  const partial = current !== null;
  if (!partial || has(body, "title")) checkText(errs, body, "title", "Judul", 120);
  if (!partial || has(body, "image_file_id")) {
    const m = media.get(String(body.image_file_id ?? ""));
    if (!m || m.purpose !== "banner_image") errs.image_file_id = ["Gambar banner wajib diunggah."];
  }
  if (!partial || has(body, "target_type") || has(body, "target_value")) {
    if (partial && (!has(body, "target_type") || !Object.prototype.hasOwnProperty.call(body, "target_value")))
      errs.target_type = ["Jenis dan nilai tujuan wajib dikirim bersama."];
    else validateTarget(errs, body.target_type, body.target_value ?? null);
  }
  if (has(body, "sort_order")) {
    const v = body.sort_order;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 32767)
      errs.sort_order = ["Urutan berupa angka 0 sampai 32767."];
  }
  if (!partial || has(body, "starts_at")) {
    if (!isIso(body.starts_at)) errs.starts_at = ["Tanggal mulai tayang wajib diisi."];
  }
  if (has(body, "ends_at") && body.ends_at !== null && !isIso(body.ends_at))
    errs.ends_at = ["Tanggal selesai tidak valid."];
  if (has(body, "active") && typeof body.active !== "boolean") errs.active = ["Status aktif tidak valid."];
  const startsAt = isIso(body.starts_at) ? body.starts_at : current?.starts_at;
  const endsAt = has(body, "ends_at") ? body.ends_at : current?.ends_at;
  if (
    !errs.starts_at &&
    !errs.ends_at &&
    isIso(endsAt) &&
    startsAt &&
    Date.parse(endsAt) <= Date.parse(startsAt)
  )
    errs.ends_at = ["Selesai tayang harus setelah mulai tayang."];
  return errs;
}

function findBanner(req: MockRequest): BannerRow | Response {
  const bad = badId(req.params.bannerId, "bannerId");
  if (bad) return bad;
  return banners.get(req.params.bannerId ?? "") ?? notFound();
}

const bannerRoutes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/content/banners",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const params = req.url.searchParams;
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const state = params.get("state");
      const sort = params.get("sort") ?? "sort_order_asc";
      const rows = [...banners.values()]
        .filter((b) => !state || bannerState(b) === state)
        .filter((b) => !q || b.title.toLowerCase().includes(q));
      const sorted =
        sort === "title_asc"
          ? sortBy(
              rows,
              (a, b) => a.title.localeCompare(b.title, "id"),
              (b) => b.id,
            )
          : sort === "starts_at_desc"
            ? sortBy(
                rows,
                (a, b) => b.starts_at.localeCompare(a.starts_at),
                (b) => b.id,
              )
            : sort === "updated_at_desc"
              ? sortBy(
                  rows,
                  (a, b) => b.updated_at.localeCompare(a.updated_at),
                  (b) => b.id,
                )
              : sortBy(
                  rows,
                  (a, b) => a.sort_order - b.sort_order || b.starts_at.localeCompare(a.starts_at),
                  (b) => b.id,
                );
      return json(200, paginate(sorted.map(bannerOut), req.url) satisfies S["AdminBannerPage"]);
    },
  },
  {
    method: "POST",
    path: "/admin/content/banners",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        const body = req.body ?? {};
        const errs = validateBanner(body, null);
        if (Object.keys(errs).length > 0) return invalid(errs);
        const at = nowIso();
        const row: BannerRow = {
          id: newId(),
          title: str(body, "title")!.trim(),
          image_file_id: str(body, "image_file_id")!,
          target_type: body.target_type as S["BannerTargetType"],
          target_value: (body.target_value as string | null) ?? null,
          sort_order: (body.sort_order as number | undefined) ?? 0,
          starts_at: str(body, "starts_at")!,
          ends_at: (body.ends_at as string | null | undefined) ?? null,
          active: (body.active as boolean | undefined) ?? true,
          version: 1,
          created_at: at,
          updated_at: at,
        };
        banners.set(row.id, row);
        return json(201, bannerOut(row));
      });
    },
  },
  {
    method: "GET",
    path: "/admin/content/banners/{bannerId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const b = findBanner(req);
      return b instanceof Response ? b : json(200, bannerOut(b));
    },
  },
  {
    method: "PATCH",
    path: "/admin/content/banners/{bannerId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const b = findBanner(req);
      if (b instanceof Response) return b;
      const body = req.body ?? {};
      if (Object.keys(body).length === 0) return invalid({ _: ["Tidak ada perubahan untuk disimpan."] });
      const errs = validateBanner(body, b);
      if (Object.keys(errs).length > 0) return invalid(errs);
      const stale = checkIfMatch(req, b.version, () => bannerOut(b));
      if (stale) return stale;
      const next: BannerRow = {
        ...b,
        title: str(body, "title")?.trim() ?? b.title,
        image_file_id: str(body, "image_file_id") ?? b.image_file_id,
        target_type: (body.target_type as S["BannerTargetType"] | undefined) ?? b.target_type,
        target_value: has(body, "target_type")
          ? ((body.target_value as string | null) ?? null)
          : b.target_value,
        sort_order: (body.sort_order as number | undefined) ?? b.sort_order,
        starts_at: str(body, "starts_at") ?? b.starts_at,
        ends_at: has(body, "ends_at") ? ((body.ends_at as string | null) ?? null) : b.ends_at,
        active: (body.active as boolean | undefined) ?? b.active,
        version: b.version + 1,
        updated_at: nowIso(),
      };
      banners.set(b.id, next);
      return json(200, bannerOut(next));
    },
  },
  {
    method: "DELETE",
    path: "/admin/content/banners/{bannerId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const b = findBanner(req);
      if (b instanceof Response) return b;
      const stale = checkIfMatch(req, b.version, () => bannerOut(b));
      if (stale) return stale;
      banners.delete(b.id);
      return noContent();
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Halaman informasi/legal
// ---------------------------------------------------------------------------------------------------------------

function findPage(req: MockRequest): PageRow | Response {
  const bad = badId(req.params.pageId, "pageId");
  if (bad) return bad;
  return pages.get(req.params.pageId ?? "") ?? notFound();
}

function pageSlugTaken(slug: string, exceptId?: string): boolean {
  return [...pages.values()].some((p) => p.slug === slug && p.id !== exceptId);
}

const pageRoutes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/content/pages",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const params = req.url.searchParams;
      const q = (params.get("q") ?? "").trim().toLowerCase();
      const sort = params.get("sort") ?? "system_first";
      const rows = [...pages.values()].filter(
        (p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q),
      );
      const sorted =
        sort === "title_asc"
          ? sortBy(
              rows,
              (a, b) => a.title.localeCompare(b.title, "id"),
              (p) => p.id,
            )
          : sort === "updated_at_desc"
            ? sortBy(
                rows,
                (a, b) => b.updated_at.localeCompare(a.updated_at),
                (p) => p.id,
              )
            : sort === "published_at_desc"
              ? sortBy(
                  rows,
                  (a, b) => desc(a.published?.published_at ?? null, b.published?.published_at ?? null),
                  (p) => p.id,
                )
              : sortBy(
                  rows,
                  (a, b) =>
                    (a.seed_order ?? 1000) - (b.seed_order ?? 1000) || a.title.localeCompare(b.title, "id"),
                  (p) => p.id,
                );
      return json(200, paginate(sorted.map(pageSummary), req.url) satisfies S["AdminInfoPageList"]);
    },
  },
  {
    method: "POST",
    path: "/admin/content/pages",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        const body = req.body ?? {};
        const errs: FieldErrors = {};
        checkSlug(errs, body, 120);
        checkText(errs, body, "title", "Judul", 200);
        checkBody(errs, body);
        if (Object.keys(errs).length > 0) return invalid(errs);
        const slug = str(body, "slug")!;
        if (pageSlugTaken(slug)) return invalid({ slug: ["Slug sudah dipakai halaman lain."] }, 409);
        const at = nowIso();
        const row = page({
          id: newId(),
          slug,
          title: str(body, "title")!.trim(),
          body_html: str(body, "body_html")!,
          created_at: at,
          updated_at: at,
          updated_by: mockAdminRef(),
        });
        pages.set(row.id, row);
        return json(201, pageDetail(row));
      });
    },
  },
  {
    method: "GET",
    path: "/admin/content/pages/{pageId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const p = findPage(req);
      return p instanceof Response ? p : json(200, pageDetail(p));
    },
  },
  {
    method: "PATCH",
    path: "/admin/content/pages/{pageId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const p = findPage(req);
      if (p instanceof Response) return p;
      const body = req.body ?? {};
      const errs: FieldErrors = {};
      if (Object.keys(body).length === 0) errs._ = ["Tidak ada perubahan untuk disimpan."];
      if (has(body, "slug")) checkSlug(errs, body, 120);
      if (has(body, "title")) checkText(errs, body, "title", "Judul", 200);
      if (has(body, "body_html")) checkBody(errs, body);
      if (Object.keys(errs).length > 0) return invalid(errs);
      const stale = checkIfMatch(req, p.version, () => pageDetail(p));
      if (stale) return stale;
      const slug = str(body, "slug");
      if (slug !== undefined && slug !== p.slug) {
        if (p.system || p.published)
          return invalid({ slug: ["Slug halaman baku atau yang pernah terbit tidak dapat diubah."] });
        if (pageSlugTaken(slug, p.id)) return invalid({ slug: ["Slug sudah dipakai halaman lain."] }, 409);
      }
      const next: PageRow = {
        ...p,
        slug: slug ?? p.slug,
        title: str(body, "title")?.trim() ?? p.title,
        body_html: str(body, "body_html") ?? p.body_html,
        version: p.version + 1,
        updated_at: nowIso(),
        updated_by: mockAdminRef(),
      };
      pages.set(p.id, next);
      return json(200, pageDetail(next));
    },
  },
  {
    method: "DELETE",
    path: "/admin/content/pages/{pageId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const p = findPage(req);
      if (p instanceof Response) return p;
      const stale = checkIfMatch(req, p.version, () => pageDetail(p));
      if (stale) return stale;
      if (p.system)
        return invalid({ _: ["Halaman baku wajib tersedia dan tidak dapat dihapus (PRD 8.2)."] }, 409);
      pages.delete(p.id);
      return noContent();
    },
  },
  {
    method: "POST",
    path: "/admin/content/pages/{pageId}/publish",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      return withIdempotency(req, () => {
        const p = findPage(req);
        if (p instanceof Response) return p;
        const body = req.body ?? {};
        const note = body.change_note;
        if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 500))
          return invalid({ change_note: ["Catatan perubahan maksimal 500 karakter."] });
        const stale = checkIfMatch(req, p.version, () => pageDetail(p));
        if (stale) return stale;
        if (!hasUnpublishedChanges(p))
          return invalid(
            { _: ["Draf sama dengan versi tayang; tidak ada perubahan untuk diterbitkan."] },
            409,
          );
        const at = nowIso();
        const next: PageRow = {
          ...p,
          published: {
            title: p.title,
            body_html: p.body_html,
            version: (p.published?.version ?? 0) + 1,
            published_at: at,
          },
          version: p.version + 1,
          updated_at: at,
          updated_by: mockAdminRef(),
        };
        pages.set(p.id, next);
        return json(200, pageDetail(next));
      });
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Gambar konten
// ---------------------------------------------------------------------------------------------------------------

/** Dimensi dari header PNG (IHDR) atau JPEG (SOFn); 1 bila tidak terbaca (server memakai decoder sungguhan). */
function dimensions(file: MockFile): { width: number; height: number } {
  const b = file.bytes;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) {
    const w = (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!;
    const h = (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!;
    if (w > 0 && h > 0) return { width: w, height: h };
  }
  for (let i = 2; i + 8 < b.length; i += 1) {
    if (b[i] === 0xff && b[i + 1]! >= 0xc0 && b[i + 1]! <= 0xc3) {
      const h = (b[i + 5]! << 8) | b[i + 6]!;
      const w = (b[i + 7]! << 8) | b[i + 8]!;
      if (w > 0 && h > 0) return { width: w, height: h };
    }
  }
  return { width: 1, height: 1 };
}

function toDataUrl(file: MockFile): string {
  let binary = "";
  for (const byte of file.bytes) binary += String.fromCharCode(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}

const mediaRoutes: MockRoute[] = [
  {
    method: "POST",
    path: "/admin/content/media",
    handler: async (req) => {
      log(req);
      const denied = requirePermission(req, "content.manage");
      if (denied) return denied;
      const form = await readMultipart(req.raw);
      if (uploadGate) await uploadGate.promise;
      const purpose = form?.purpose;
      const file = form?.file;
      if (purpose !== "post_cover" && purpose !== "banner_image")
        return invalid({ purpose: ["Purpose gambar tidak dikenal."] });
      if (!file || typeof file === "string") return invalid({ file: ["Gambar wajib dipilih."] });
      if (file.type !== "image/jpeg" && file.type !== "image/png")
        return error(415, "FILE_INVALID", "Tipe berkas tidak diterima.");
      if (file.size > IMAGE_MAX) return error(413, "FILE_INVALID", "Gambar maksimal 5 MB.");
      const used = uploads.get(purpose) ?? 0;
      if (used >= UPLOADS_PER_PURPOSE)
        return error(429, "RATE_LIMITED", "Batas unggah gambar tercapai. Coba lagi nanti.", {
          retry_after_seconds: 3600,
        });
      uploads.set(purpose, used + 1);
      const row: MediaRow = {
        file_id: newId(),
        purpose,
        url: toDataUrl(file),
        mime: file.type,
        bytes: file.size,
        ...dimensions(file),
      };
      media.set(row.file_id, row);
      return json(201, row satisfies S["ContentMedia"]);
    },
  },
];

export const routes: MockRoute[] = [
  ...postRoutes,
  ...bannerRoutes,
  ...pageRoutes,
  ...postCategoryRoutes(),
  ...mediaRoutes,
];

/** Kendali server tiruan untuk uji: meniru pengurus lain mengubah objek (AC F15-4) dan membaca keadaan. */
export const mockContent = {
  post(id: string): S["AdminPost"] | undefined {
    const p = posts.get(id);
    return p ? postDetail(p) : undefined;
  },
  banner(id: string): S["AdminBanner"] | undefined {
    const b = banners.get(id);
    return b ? bannerOut(b) : undefined;
  },
  page(id: string): S["AdminInfoPage"] | undefined {
    const p = pages.get(id);
    return p ? pageDetail(p) : undefined;
  },
  category(id: string): S["AdminContentCategory"] | undefined {
    const c = categories.get(id);
    return c ? categoryOut(c) : undefined;
  },
  /** Kategori berdasarkan jenis dan label (mis. kategori yang baru dibuat lewat UI dalam uji). */
  categoryByLabel(kind: Kind, label: string): S["AdminContentCategory"] | undefined {
    const c = [...categories.values()].find((x) => x.kind === kind && x.label === label);
    return c ? categoryOut(c) : undefined;
  },
  /** Pengurus lain menyunting berita: versi naik. */
  editPostElsewhere(id: string, patch: Partial<Pick<PostRow, "title" | "body_html" | "excerpt">> = {}): void {
    const p = posts.get(id);
    if (p) updatePost(p, { title: "Judul diubah pengurus lain", ...patch });
  },
  /** Berita dihapus langsung (mis. tujuan banner yang sudah dihapus pengurus lain, AC F08-2). */
  deletePost(id: string): void {
    posts.delete(id);
  },
  /** Tahan semua unggahan gambar konten sampai fungsi yang dikembalikan dipanggil (unggahan sedang berjalan). */
  holdUploads(): () => void {
    const held = gate(false);
    uploadGate = held;
    return () => {
      if (uploadGate === held) uploadGate = null;
      held.release();
    };
  },
  /**
   * Tahan permintaan daftar kategori berita berikutnya sampai fungsi yang dikembalikan dipanggil; dengan `fail`
   * permintaan itu dijawab 500 setelah dilepas. Permintaan sesudahnya berjalan normal.
   */
  holdCategoryList(fail = false): () => void {
    const held = gate(fail);
    categoryListGate = held;
    return () => held.release();
  },
  /** Waktu jadwal berita tiba (job menerbitkan): published_at dipindah ke masa lalu. */
  makeScheduledDue(id: string): void {
    const p = posts.get(id);
    if (p) posts.set(id, { ...p, published_at: new Date(Date.now() - 1000).toISOString() });
  },
  editBannerElsewhere(id: string): void {
    const b = banners.get(id);
    if (b)
      banners.set(id, { ...b, title: `${b.title} (diubah)`, version: b.version + 1, updated_at: nowIso() });
  },
  editPageElsewhere(id: string, bodyHtml = "<p>Draf diubah pengurus lain.</p>"): void {
    const p = pages.get(id);
    if (p) pages.set(id, { ...p, body_html: bodyHtml, version: p.version + 1, updated_at: nowIso() });
  },
  editCategoryElsewhere(id: string): void {
    const c = categories.get(id);
    if (c)
      categories.set(id, {
        ...c,
        label: `${c.label} (diubah)`,
        version: c.version + 1,
        updated_at: nowIso(),
      });
  },
  /** Berita lain mulai memakai kategori (balapan hapus kategori: FK RESTRICT di server). */
  useCategory(categoryId: string): void {
    const p = posts.get(ID.postDraft);
    if (p) posts.set(p.id, { ...p, category_id: categoryId });
  },
};
