/**
 * Seed pengembangan/staging dengan fixture SINTETIS yang ditandai jelas "[Contoh]" dan domain email `.test`
 * (PRD 6.5, 5.3: data staging sintetis, tidak pernah dijalankan pada production). Menolak berjalan bila
 * NODE_ENV=production. Idempoten: id fixture tetap, baris yang sudah ada dilewati.
 *
 * Isi: seluruh data referensi (seeds/reference.ts) + master diaktifkan + halaman legal draf diterbitkan sebagai
 * contoh, metode bayar "[Bank Contoh]", kategori, satu berita, satu event terbuka, dan tiga alumni contoh
 * (belum bayar, aktif, menunggu verifikasi bayar). Sandi seluruh akun contoh: Kapdh#Dev2026 (hanya dev).
 * Super Admin TIDAK dibuat di sini; gunakan `pnpm --filter @kapdh/api admin:bootstrap` (PRD 8.2).
 *
 *   NODE_ENV=development DATABASE_URL=postgres://... pnpm --filter @kapdh/database seed:dev
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../src/client.js";
import { categories, pages, posts } from "../src/schema/content.js";
import { events } from "../src/schema/events.js";
import { users } from "../src/schema/identity.js";
import { alumni, masterProfessions, masterSkills, membershipEvents } from "../src/schema/membership.js";
import { paymentEvents, paymentMethods, payments } from "../src/schema/payments.js";
import { auditLogs } from "../src/schema/platform.js";
import { appSettings } from "../src/schema/settings.js";
import { LEGAL_PAGE_SHELLS, seedReference } from "./reference.js";

/** bcrypt(cost 10) dari "Kapdh#Dev2026". Hanya untuk fixture dev; tidak pernah dipakai di production. */
const DEV_PASSWORD_HASH = "$2b$10$IvcCOUy99dA1QKRUM5KFmeJkWkxedXaNh0Jrmw.JZ5alT03ZlOVkK";

/** Id tetap (format UUID v7) agar seed dapat diulang tanpa duplikasi. */
export const DEV_IDS = {
  paymentMethod: "0192a000-0000-7000-8000-000000000001",
  categoryNews: "0192a000-0000-7000-8000-000000000011",
  categoryActivity: "0192a000-0000-7000-8000-000000000012",
  categoryGathering: "0192a000-0000-7000-8000-000000000013",
  categoryStudy: "0192a000-0000-7000-8000-000000000014",
  post: "0192a000-0000-7000-8000-000000000021",
  event: "0192a000-0000-7000-8000-000000000031",
  alumniUnverified: "0192a000-0000-7000-8000-000000000101",
  alumniVerified: "0192a000-0000-7000-8000-000000000102",
  alumniPending: "0192a000-0000-7000-8000-000000000103",
  paymentVerified: "0192a000-0000-7000-8000-000000000201",
  paymentPending: "0192a000-0000-7000-8000-000000000202",
} as const;

export class ProductionSeedRefused extends Error {
  constructor() {
    super(
      "seed:dev menolak berjalan pada NODE_ENV=production (fixture sintetis dilarang di production, PRD 8.2).",
    );
  }
}

export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "production") throw new ProductionSeedRefused();
}

interface AlumniFixture {
  userId: string;
  email: string;
  fullName: string;
  gender: "male" | "female";
  cohort: number;
  classIn: number;
  classOut: number;
  city: string;
}

const ALUMNI_FIXTURES: AlumniFixture[] = [
  {
    userId: DEV_IDS.alumniUnverified,
    email: "contoh1@kapdh.test",
    fullName: "[Contoh] Ahmad Fauzi",
    gender: "male",
    cohort: 25,
    classIn: 1,
    classOut: 6,
    city: "Bogor",
  },
  {
    userId: DEV_IDS.alumniVerified,
    email: "contoh2@kapdh.test",
    fullName: "[Contoh] Siti Aisyah",
    gender: "female",
    cohort: 20,
    classIn: 1,
    classOut: 3,
    city: "Jakarta",
  },
  {
    userId: DEV_IDS.alumniPending,
    email: "contoh3@kapdh.test",
    fullName: "[Contoh] Muhammad Rizki",
    gender: "male",
    cohort: 28,
    classIn: 4,
    classOut: 6,
    city: "Depok",
  },
];

/**
 * Nomor AA.SS.JK.N (PRD 3.5). Rumus sama dengan apps/api/src/membership/member-number.ts dan divalidasi CHECK
 * alumni_member_number_chk di database.
 */
function memberNumber(f: AlumniFixture, seq: number): string {
  const finishedMts = f.classIn <= 3 && f.classOut >= 3;
  const finishedAliyah = f.classOut === 6;
  const ss = finishedMts && finishedAliyah ? "01" : finishedMts || finishedAliyah ? "02" : "03";
  return `${String(f.cohort).padStart(2, "0")}.${ss}.${f.gender === "male" ? "01" : "02"}.${seq}`;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

const DAY = 24 * 3600_000;

export interface DevSeedSummary {
  reference: Awaited<ReturnType<typeof seedReference>>;
  alumni_inserted: number;
}

export async function seedDev(db: Database, options: { now?: Date } = {}): Promise<DevSeedSummary> {
  assertNotProduction();
  const now = options.now ?? new Date();
  const requestId = `seed-dev-${uuidv7()}`;
  const reference = await seedReference(db, { now, requestId });

  const alumniInserted = await db.transaction(async (tx) => {
    // Lingkungan dev: master usulan diaktifkan dan halaman draf diterbitkan sebagai contoh.
    await tx
      .update(masterProfessions)
      .set({ active: true, updatedAt: now })
      .where(eq(masterProfessions.active, false));
    await tx.update(masterSkills).set({ active: true, updatedAt: now }).where(eq(masterSkills.active, false));
    // Terbit = salin draf ke salinan tayang dan versi legal 1 (F-01, PRD 6.2), selaras app_settings `legal` di bawah.
    await tx
      .update(pages)
      .set({
        publishedTitle: sql`${pages.title}`,
        publishedBodyHtml: sql`${pages.bodyHtml}`,
        publishedVersion: 1,
        publishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          isNull(pages.publishedAt),
          inArray(
            pages.slug,
            LEGAL_PAGE_SHELLS.map((p) => p.slug),
          ),
        ),
      );
    await tx
      .update(appSettings)
      .set({
        value: { privacy_version: "1", terms_version: "1", community_version: "1" },
        version: sql`${appSettings.version} + 1`,
        updatedAt: now,
      })
      .where(sql`${appSettings.key} = 'legal' and ${appSettings.value}->>'privacy_version' is null`);

    await tx
      .insert(paymentMethods)
      .values({
        id: DEV_IDS.paymentMethod,
        kind: "bank",
        provider: "[Bank Contoh]",
        accountNumber: "0000000000",
        accountHolder: "KAPDH (Contoh)",
        instructions: "Rekening contoh untuk pengembangan. Jangan melakukan transfer.",
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await tx
      .insert(categories)
      .values([
        { id: DEV_IDS.categoryNews, kind: "post", label: "Pengumuman", slug: "pengumuman", sortOrder: 1 },
        {
          id: DEV_IDS.categoryActivity,
          kind: "post",
          label: "Kegiatan Alumni",
          slug: "kegiatan-alumni",
          sortOrder: 2,
        },
        {
          id: DEV_IDS.categoryGathering,
          kind: "event",
          label: "Silaturahmi",
          slug: "silaturahmi",
          sortOrder: 1,
        },
        { id: DEV_IDS.categoryStudy, kind: "event", label: "Kajian", slug: "kajian", sortOrder: 2 },
      ])
      .onConflictDoNothing();

    await tx
      .insert(posts)
      .values({
        id: DEV_IDS.post,
        slug: "contoh-selamat-datang",
        title: "[Contoh] Selamat datang di KAPDH Apps",
        excerpt: "Berita contoh untuk lingkungan pengembangan.",
        bodyHtml: "<p>Berita contoh. Data ini sintetis dan hanya untuk pengembangan.</p>",
        categoryId: DEV_IDS.categoryNews,
        status: "published",
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const eventStart = new Date(now.getTime() + 30 * DAY);
    await tx
      .insert(events)
      .values({
        id: DEV_IDS.event,
        title: "[Contoh] Silaturahmi Akbar Alumni",
        description: "Event contoh untuk pengembangan.",
        categoryId: DEV_IDS.categoryGathering,
        locationName: "Aula Contoh",
        startsAt: eventStart,
        endsAt: new Date(eventStart.getTime() + 4 * 3600_000),
        registrationOpensAt: now,
        registrationClosesAt: new Date(eventStart.getTime() - DAY),
        price: "50000.00",
        seatsTotal: 100,
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const [fees] = await tx
      .select({ version: appSettings.version })
      .from(appSettings)
      .where(eq(appSettings.key, "fees"));
    const method = await tx.query.paymentMethods.findFirst({
      where: eq(paymentMethods.id, DEV_IDS.paymentMethod),
    });
    const methodSnapshot = method
      ? {
          id: method.id,
          kind: method.kind,
          provider: method.provider,
          account_number: method.accountNumber,
          account_holder: method.accountHolder,
        }
      : {};
    const registrationLines = [
      { code: "registration_fee", label: "Registrasi alumni baru", amount: "50000.00" },
      { code: "card_fee", label: "Pembuatan KTA", amount: "10000.00" },
    ];

    let inserted = 0;
    for (const f of ALUMNI_FIXTURES) {
      const created = await tx
        .insert(users)
        .values({
          id: f.userId,
          email: f.email,
          passwordHash: DEV_PASSWORD_HASH,
          status: "active",
          kind: "alumni",
          emailVerifiedAt: now,
          policyVersion: "1",
          policyAcceptedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (created.length === 0) continue;
      inserted += 1;

      const result = await tx.execute<{ seq: string }>(
        sql`select nextval('app.membership_no_seq')::text as seq`,
      );
      // postgres-js mengembalikan array, PGlite mengembalikan { rows }.
      const rows =
        (result as unknown as { rows?: { seq: string }[] }).rows ?? (result as unknown as { seq: string }[]);
      const seq = Number(rows[0]?.seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Gagal mengalokasikan nomor urut anggota.");
      const verified = f.userId === DEV_IDS.alumniVerified;
      const startsAt = verified ? new Date(now.getTime() - 30 * DAY) : null;
      await tx.insert(alumni).values({
        userId: f.userId,
        fullName: f.fullName,
        gender: f.gender,
        cohort: f.cohort,
        classIn: f.classIn,
        classOut: f.classOut,
        city: f.city,
        memberSeq: seq,
        memberNumber: memberNumber(f, seq),
        startsAt,
        expiresAt: startsAt ? addMonths(startsAt, 12) : null,
        createdAt: now,
        updatedAt: now,
      });

      if (verified || f.userId === DEV_IDS.alumniPending) {
        const paymentId = verified ? DEV_IDS.paymentVerified : DEV_IDS.paymentPending;
        await tx.insert(payments).values({
          id: paymentId,
          userId: f.userId,
          type: "registration",
          status: verified ? "paid" : "pending",
          amount: "60000.00",
          linesSnapshot: registrationLines,
          methodSnapshot,
          settingsVersion: fees?.version ?? 1,
          paymentMethodId: method?.id ?? null,
          proofVersion: verified ? 1 : 0,
          submittedAt: verified ? startsAt : null,
          decidedAt: verified ? startsAt : null,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(paymentEvents).values({
          id: uuidv7(),
          paymentId,
          kind: "created",
          actorUserId: f.userId,
          createdAt: now,
        });
        if (verified && startsAt) {
          await tx.insert(paymentEvents).values({
            id: uuidv7(),
            paymentId,
            kind: "approved",
            proofVersion: 1,
            reason: "Fixture dev",
            createdAt: now,
          });
          await tx.insert(membershipEvents).values({
            id: uuidv7(),
            userId: f.userId,
            kind: "activation",
            paymentId,
            afterStartsAt: startsAt,
            afterExpiresAt: addMonths(startsAt, 12),
            afterMemberNumber: memberNumber(f, seq),
            createdAt: now,
          });
        }
      }
    }

    await tx.insert(auditLogs).values({
      id: uuidv7(),
      effectiveRole: "system",
      action: "seed.dev",
      entityType: "seed",
      entityId: "dev",
      requestId,
      after: { alumni_inserted: inserted, fixtures: "sintetis" },
      createdAt: now,
    });
    return inserted;
  });

  return { reference, alumni_inserted: alumniInserted };
}
