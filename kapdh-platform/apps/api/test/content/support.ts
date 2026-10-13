/**
 * Fixture uji modul konten (F-08, F-15): sesi anggota/pengurus, berita/kategori/event/banner yang disisipkan langsung
 * dengan invarian skema yang sama dengan alur layanan, dan unggah gambar konten lewat endpoint domain.
 */
import type { Permission } from "@kapdh/contracts";
import { banners, categories, events, posts } from "@kapdh/database";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import {
  type AlumniFixtureStatus,
  createAdmin,
  createAlumni,
  signInAdmin,
  signInAlumni,
} from "../support/factories.js";
import { multipartBody, testJpeg } from "../support/files.js";
import type { TestApp } from "../support/test-app.js";

let counter = 0;
/** Akhiran unik untuk slug/judul agar uji dalam satu berkas tidak saling bertabrakan. */
export function unique(prefix: string): string {
  return `${prefix}-${++counter}-${uuidv7().slice(-6)}`;
}

export async function memberSession(t: TestApp, status: AlumniFixtureStatus = "verified") {
  const fixture = await createAlumni(t, { status });
  const session = await signInAlumni(t, fixture);
  return { ...fixture, token: session.accessToken };
}

export async function adminSession(
  t: TestApp,
  permissions: Permission[],
  options: { role?: "admin" | "super_admin"; displayName?: string } = {},
) {
  const fixture = await createAdmin(t, { permissions, role: options.role, displayName: options.displayName });
  const session = await signInAdmin(t, fixture);
  return { ...fixture, permissions, token: session.accessToken };
}

export async function insertCategory(
  t: TestApp,
  options: {
    kind?: "post" | "event";
    label?: string;
    slug?: string;
    active?: boolean;
    sortOrder?: number;
  } = {},
) {
  const now = t.clock.now();
  const slug = options.slug ?? unique("kategori");
  const [row] = await t.db
    .insert(categories)
    .values({
      id: uuidv7(),
      kind: options.kind ?? "post",
      label: options.label ?? `Kategori ${slug}`,
      slug,
      active: options.active ?? true,
      sortOrder: options.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export interface InsertPostOptions {
  status?: "draft" | "published" | "archived";
  publishedAt?: Date | null;
  announcedAt?: Date | null;
  slug?: string;
  title?: string;
  excerpt?: string | null;
  bodyHtml?: string;
  categoryId?: string | null;
  coverFileId?: string | null;
}

/** Berita langsung di database (memenuhi posts_published_chk / posts_announced_chk). */
export async function insertPost(t: TestApp, options: InsertPostOptions = {}) {
  const now = t.clock.now();
  const slug = options.slug ?? unique("berita");
  const status = options.status ?? "published";
  const [row] = await t.db
    .insert(posts)
    .values({
      id: uuidv7(),
      slug,
      title: options.title ?? `Judul ${slug}`,
      excerpt: options.excerpt ?? null,
      bodyHtml: options.bodyHtml ?? "<p>Isi berita uji.</p>",
      status,
      publishedAt:
        options.publishedAt !== undefined
          ? options.publishedAt
          : status === "published"
            ? new Date(now.getTime() - 3600_000)
            : null,
      announcedAt: options.announcedAt ?? null,
      categoryId: options.categoryId ?? null,
      coverFileId: options.coverFileId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export interface InsertEventOptions {
  status?: "draft" | "open" | "closed" | "done" | "cancelled";
  startsAt?: Date;
  endsAt?: Date;
  registrationOpensAt?: Date;
  registrationClosesAt?: Date;
  price?: string;
  seatsTotal?: number;
  heldQuantity?: number;
  paidQuantity?: number;
  categoryId?: string | null;
  title?: string;
}

/** Event sintetis (baca saja oleh modul konten; tabel milik modul events). */
export async function insertEvent(t: TestApp, options: InsertEventOptions = {}) {
  const now = t.clock.now();
  const day = 24 * 3600_000;
  const startsAt = options.startsAt ?? new Date(now.getTime() + 7 * day);
  const endsAt = options.endsAt ?? new Date(startsAt.getTime() + 4 * 3600_000);
  const status = options.status ?? "open";
  const [row] = await t.db
    .insert(events)
    .values({
      id: uuidv7(),
      title: options.title ?? unique("Event"),
      categoryId: options.categoryId ?? null,
      locationName: "Aula Darel Hikmah",
      startsAt,
      endsAt,
      registrationOpensAt: options.registrationOpensAt ?? new Date(now.getTime() - day),
      registrationClosesAt: options.registrationClosesAt ?? new Date(startsAt.getTime() - 3600_000),
      price: options.price ?? "50000.00",
      seatsTotal: options.seatsTotal ?? 100,
      heldQuantity: options.heldQuantity ?? 0,
      paidQuantity: options.paidQuantity ?? 0,
      status,
      cancelledAt: status === "cancelled" ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

/** POST /admin/content/media multipart; mengembalikan respons mentah. */
export async function postContentMedia(
  t: TestApp,
  token: string,
  purpose: string,
  options: { data?: Buffer; filename?: string; contentType?: string } = {},
) {
  const body = multipartBody([
    { name: "purpose", value: purpose },
    {
      name: "file",
      filename: options.filename ?? "gambar.jpg",
      contentType: options.contentType ?? "image/jpeg",
      data: options.data ?? (await testJpeg({ width: 120, height: 60 })),
    },
  ]);
  return t.app.inject({
    method: "POST",
    url: "/api/v1/admin/content/media",
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${token}` },
  });
}

/** Unggah gambar konten yang wajib berhasil; mengembalikan ContentMedia. */
export async function uploadContentMedia(
  t: TestApp,
  token: string,
  purpose: "post_cover" | "banner_image",
): Promise<{ file_id: string; url: string }> {
  const res = await postContentMedia(t, token, purpose);
  expect(res.statusCode, `unggah ${purpose}: ${res.body}`).toBe(201);
  return res.json();
}

/** Banner langsung di database (gambar wajib berkas banner_image yang sudah ada). */
export async function insertBanner(
  t: TestApp,
  imageFileId: string,
  options: {
    title?: string;
    targetType?: "none" | "post" | "event" | "page" | "url";
    targetValue?: string | null;
    startsAt?: Date;
    endsAt?: Date | null;
    active?: boolean;
    sortOrder?: number;
  } = {},
) {
  const now = t.clock.now();
  const [row] = await t.db
    .insert(banners)
    .values({
      id: uuidv7(),
      title: options.title ?? unique("Banner"),
      imageFileId,
      targetType: options.targetType ?? "none",
      targetValue: options.targetValue ?? null,
      sortOrder: options.sortOrder ?? 0,
      startsAt: options.startsAt ?? new Date(now.getTime() - 3600_000),
      endsAt: options.endsAt === undefined ? null : options.endsAt,
      active: options.active ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function postRow(t: TestApp, id: string) {
  const [row] = await t.db.select().from(posts).where(eq(posts.id, id));
  return row;
}
