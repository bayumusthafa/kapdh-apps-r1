import { describe, expect, it } from "vitest";
import type { components } from "@kapdh/contracts";
import { bannerChanges, type BannerFormValues } from "./BannerFormDialog";
import { conflictHeadline } from "./ConflictNotice";
import { conflictCurrent, conflictState, errorText, slugFromTitle } from "./contentApi";
import { sanitizeContentHtml } from "./HtmlPreview";
import { pageChanges, publishExplanation } from "./PagesTab";
import { postChanges, toPostForm } from "./PostEditorPage";
import { transitionMessage } from "./PostPublishPanel";
import { canDeletePost, publicationText } from "./PostsTab";
import { parseContentSearch } from "./routes";
import { ApiError } from "../../api/errors";

type S = components["schemas"];

const POST: S["AdminPost"] = {
  id: "0199e100-0000-7000-8000-000000000101",
  slug: "donasi-korban-bencana",
  title: "Donasi korban bencana",
  state: "published",
  category: { id: "0199e100-0000-7000-8000-000000000402", slug: "event-bulanan", label: "Event Bulanan" },
  cover: { file_id: "0199e100-0000-7000-8000-000000000701", url: "https://files.kapdh.or.id/c.jpg" },
  published_at: "2026-08-03T02:00:00Z",
  like_count: 4,
  version: "3",
  created_at: "2026-08-01T02:00:00Z",
  updated_at: "2026-08-03T02:00:00Z",
  excerpt: null,
  body_html: "<p>Isi</p>",
  announced_at: "2026-08-03T02:00:30Z",
  slug_locked: true,
  author: null,
};

const BANNER: S["AdminBanner"] = {
  id: "0199e100-0000-7000-8000-000000000201",
  title: "Donasi",
  image: { file_id: "0199e100-0000-7000-8000-000000000711", url: "https://files.kapdh.or.id/b.jpg" },
  target: {
    type: "page",
    value: "bantuan",
    available: true,
    label: "Bantuan",
    route: "/legal/bantuan",
    category: null,
  },
  sort_order: 2,
  starts_at: "2026-08-03T00:00:00Z",
  ends_at: null,
  active: true,
  state: "live",
  version: "1",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

const PAGE: S["AdminInfoPage"] = {
  id: "0199e100-0000-7000-8000-000000000301",
  slug: "kebijakan-privasi",
  title: "Kebijakan Privasi",
  legal_document: "privacy",
  system: true,
  published_version: "2",
  published_at: "2026-09-01T02:00:00Z",
  has_unpublished_changes: true,
  version: "5",
  updated_at: "2026-09-02T02:00:00Z",
  updated_by: null,
  body_html: "<p>Draf</p>",
  published: {
    title: "Kebijakan Privasi",
    body_html: "<p>Tayang</p>",
    version: "2",
    published_at: "2026-09-01T02:00:00Z",
  },
  slug_locked: true,
  created_at: "2026-07-01T02:00:00Z",
};

describe("sanitasi pratinjau isi (PRD 3.8)", () => {
  it("membangun ulang hanya tag/atribut yang diizinkan: script, handler dan URL berbahaya tidak pernah lolos", () => {
    const html = sanitizeContentHtml(
      '<p onclick="alert(1)">Halo <strong>alumni</strong><script>alert(2)</script></p>' +
        '<img src="http://evil.test/x.png" alt="x" onerror="alert(3)"><img src="https://files.kapdh.or.id/a.png" alt="Foto">' +
        '<a href="javascript:alert(4)">bahaya</a> <a href="https://kapdh.or.id" onmouseover="x()">situs</a>' +
        '<iframe src="https://evil.test"></iframe><div><span style="color:red">teks div</span></div><style>p{}</style>',
    );
    expect(html).not.toMatch(/script|onclick|onerror|onmouseover|javascript:|iframe|style|evil\.test/);
    expect(html).toContain("<p>Halo <strong>alumni</strong></p>");
    expect(html).toContain('<img src="https://files.kapdh.or.id/a.png" alt="Foto"');
    expect(html).toContain("bahaya");
    expect(html).toContain(
      '<a href="https://kapdh.or.id" target="_blank" rel="noopener noreferrer nofollow"',
    );
    expect(html).toContain("(tautan luar, tab baru)");
    expect(html).toContain("teks div");
  });

  it("tautan mailto tidak ditandai sebagai tautan luar", () => {
    expect(sanitizeContentHtml('<a href="mailto:bantuan@kapdh.or.id">surel</a>')).toBe(
      '<a href="mailto:bantuan@kapdh.or.id">surel</a>',
    );
  });
});

describe("perubahan formulir dikirim minimal (kontrak PATCH)", () => {
  it("postChanges hanya mengirim field yang berubah; slug terkunci tidak pernah dikirim; ringkasan kosong = null", () => {
    const form = toPostForm(POST);
    expect(postChanges(form, POST)).toEqual({});
    expect(postChanges({ ...form, title: " Donasi baru ", slug: "slug-baru", excerpt: "  " }, POST)).toEqual({
      title: "Donasi baru",
    });
    expect(postChanges({ ...form, category_id: "", cover_file_id: null, excerpt: "Ringkas" }, POST)).toEqual({
      category_id: null,
      cover_file_id: null,
      excerpt: "Ringkas",
    });
    expect(postChanges({ ...form, slug: "slug-baru" }, { ...POST, slug_locked: false })).toEqual({
      slug: "slug-baru",
    });
  });

  it("bannerChanges mengirim jenis dan nilai tujuan berpasangan; waktu yang sama tidak dianggap berubah", () => {
    const form: BannerFormValues = {
      title: "Donasi",
      image_file_id: BANNER.image,
      target_type: "page",
      target_value: "bantuan",
      target_label: "Bantuan",
      sort_order: "2",
      starts_at: "2026-08-03T00:00:00.000Z",
      ends_at: null,
      active: true,
    };
    expect(bannerChanges(form, BANNER)).toEqual({});
    expect(bannerChanges({ ...form, target_value: "tentang" }, BANNER)).toEqual({
      target_type: "page",
      target_value: "tentang",
    });
    expect(bannerChanges({ ...form, target_type: "none", target_value: "bantuan" }, BANNER)).toEqual({
      target_type: "none",
      target_value: null,
    });
    expect(bannerChanges({ ...form, ends_at: "2026-09-01T00:00:00.000Z", sort_order: "0" }, BANNER)).toEqual({
      ends_at: "2026-09-01T00:00:00.000Z",
      sort_order: 0,
    });
  });

  it("pageChanges tidak mengirim slug halaman terkunci", () => {
    expect(pageChanges({ title: "Kebijakan Privasi", slug: "lain", body_html: "<p>Draf</p>" }, PAGE)).toEqual(
      {},
    );
    expect(
      pageChanges({ title: "Kebijakan Privasi", slug: "kebijakan-privasi", body_html: "<p>Baru</p>" }, PAGE),
    ).toEqual({
      body_html: "<p>Baru</p>",
    });
  });
});

describe("teks status dan konfirmasi", () => {
  it("F-01: penjelasan terbit dokumen legal menyebut kenaikan versi, persetujuan registrasi dan audit", () => {
    const lines = publishExplanation(PAGE).join(" ");
    expect(lines).toContain("naik dari versi 2 menjadi versi 3");
    expect(lines).toContain("Registrasi berikutnya menyetujui pasangan versi");
    expect(lines).toContain("dicatat di audit");
    const first = publishExplanation({
      ...PAGE,
      legal_document: null,
      published: null,
      published_version: null,
    });
    expect(first[0]).toContain("pertama kali sebagai versi 1");
    expect(first.join(" ")).not.toContain("Registrasi berikutnya");
  });

  it("AC F08-1: tanggal publikasi terjadwal ditampilkan dengan jam WIB; hapus hanya draf/arsip", () => {
    expect(publicationText({ state: "scheduled", published_at: "2030-01-15T02:30:00Z" })).toBe(
      "15 Jan 2030, 09.30 WIB",
    );
    expect(publicationText({ state: "published", published_at: "2026-08-03T02:00:00Z" })).toBe("3 Agt 2026");
    expect(publicationText({ state: "draft", published_at: null })).toBe("-");
    expect(canDeletePost("draft")).toBe(true);
    expect(canDeletePost("archived")).toBe(true);
    expect(canDeletePost("scheduled")).toBe(false);
    expect(canDeletePost("published")).toBe(false);
  });

  it("pesan transisi membedakan terbit sekarang, terjadwal dan terbit ulang", () => {
    const draft = { ...POST, state: "draft" as const, slug_locked: false };
    expect(transitionMessage({ action: "publish" }, { ...POST, state: "published" }, draft)).toBe(
      "Berita diterbitkan dan tampil di aplikasi.",
    );
    expect(
      transitionMessage(
        { action: "publish", published_at: "2030-01-15T02:30:00Z" },
        { ...POST, state: "scheduled", published_at: "2030-01-15T02:30:00Z" },
        draft,
      ),
    ).toBe("Berita dijadwalkan terbit 15 Jan 2030, 09.30 WIB.");
    expect(transitionMessage({ action: "publish" }, POST, { ...draft, slug_locked: true })).toBe(
      "Berita tampil kembali dengan tanggal publikasi aslinya.",
    );
  });
});

describe("bantuan area konten", () => {
  it("parameter URL tab/halaman yang tidak dikenal diabaikan; kategori event tidak lagi dikelola dari /content", () => {
    expect(parseContentSearch({ tab: "pages", page: PAGE.id })).toEqual({ tab: "pages", page: PAGE.id });
    expect(parseContentSearch({ tab: "categories", kind: "event" })).toEqual({ tab: "categories" });
    expect(parseContentSearch({ tab: "x", page: "../etc" })).toEqual({});
  });

  it("slug saran dari judul", () => {
    expect(slugFromTitle("Halal bi Halal 2026!")).toBe("halal-bi-halal-2026");
    expect(slugFromTitle("  Ruwatan Désa  ")).toBe("ruwatan-desa");
  });

  it("AC F15-4: objek terbaru diambil dari VERSION_CONFLICT hanya bila id cocok; pesan galat umum diutamakan", () => {
    const conflict = new ApiError({
      code: "VERSION_CONFLICT",
      status: 409,
      message: "Berubah",
      current: POST,
    });
    expect(conflictCurrent<S["AdminPost"]>(conflict, POST.id)).toBe(POST);
    expect(conflictCurrent(conflict, BANNER.id)).toBeNull();
    expect(
      conflictCurrent(new ApiError({ code: "IDEMPOTENCY_CONFLICT", status: 409, message: "x" }), POST.id),
    ).toBeNull();
    const inUse = new ApiError({
      code: "VALIDATION_ERROR",
      status: 409,
      message: "Periksa kembali isian yang ditandai.",
      fieldErrors: { _: ["Kategori masih dipakai 2 berita."] },
    });
    expect(errorText(inUse)).toBe("Kategori masih dipakai 2 berita.");
    expect(errorText(conflict)).toBe("Berubah");
  });

  it("AC F15-4/F15-5: penyebab konflik dibedakan — diubah pengurus lain, status berubah sendiri, atau tabrakan permintaan", () => {
    const edited = new ApiError({
      code: "VERSION_CONFLICT",
      status: 409,
      message: "Berubah",
      current: { ...POST, version: "4" },
    });
    expect(conflictState<S["AdminPost"]>(edited, POST)).toEqual({
      cause: "edited",
      latest: { ...POST, version: "4" },
    });
    // Jadwal tiba: keadaan turunan berubah tanpa versi naik; bukan "diubah pengurus lain".
    const due = new ApiError({ code: "VERSION_CONFLICT", status: 409, message: "x", current: POST });
    expect(conflictState<S["AdminPost"]>(due, { id: POST.id, version: "3" })).toEqual({
      cause: "state_changed",
      latest: POST,
    });
    // VERSION_CONFLICT tanpa `current` yang cocok tetap konflik versi, tanpa data terbaru.
    expect(conflictState(new ApiError({ code: "VERSION_CONFLICT", status: 409, message: "x" }), POST)).toEqual({
      cause: "edited",
      latest: null,
    });
    expect(
      conflictState(new ApiError({ code: "IDEMPOTENCY_CONFLICT", status: 409, message: "x", current: POST }), POST),
    ).toEqual({ cause: "unconfirmed", latest: null });
  });

  it("AC F15-4: kalimat pemberitahuan konflik mengikuti penyebab dan tidak menuduh pengurus lain tanpa dasar", () => {
    expect(conflictHeadline("edited", "Berita ini", "2026-08-03T02:00:00Z")).toBe(
      "Berita ini sudah diubah pengurus lain pada 3 Agt 2026, 09.00 WIB.",
    );
    expect(conflictHeadline("edited", "Halaman ini", null, "Nur Hidayah")).toBe(
      "Halaman ini sudah diubah pengurus lain oleh Nur Hidayah.",
    );
    expect(conflictHeadline("state_changed", "Berita ini", "2026-08-03T02:00:00Z", "Nur Hidayah")).toBe(
      "Status berita ini sudah berubah sejak halaman ini dimuat.",
    );
    expect(conflictHeadline("unconfirmed", "Banner ini")).toBe("Permintaan untuk banner ini tidak dijalankan.");
  });
});
