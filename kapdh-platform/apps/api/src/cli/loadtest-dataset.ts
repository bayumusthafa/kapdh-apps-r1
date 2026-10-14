/**
 * Dataset SINTETIS uji beban staging (PRD 2.4 kondisi uji N-01, N-02, N-04; PRD 5.3 staging hanya data sintetis;
 * docs/runbooks/load-test.md). Ukuran bawaan sama dengan kondisi uji PRD 2.4: 5.000 profil, 100.000 pesan, 100 akun
 * anggota yang dapat login (100 sesi anggota) dan 5 admin ber-TOTP (5 sesi admin), ditambah event gratis terbuka
 * (reservasi), payment renewal menunggu keputusan (keputusan admin) dan berita terbit.
 *
 * Data dibuat langsung di database dengan invarian yang sama dengan alur produksi (nomor anggota dari nextval pada
 * sesi yang sama, periode 12 bulan, admin aktif dengan TOTP terenkripsi TOTP_ENC_KEY, room/anggota/pesan berurutan
 * (created_at, id)), seperti fixture uji `test/support/factories.ts`. Semua akun memakai domain
 * `@uji-beban.kapdh.test` dan bio/judul bertanda "[Uji Beban]" sehingga tidak tertukar dengan data nyata. Nama orang
 * sengaja wajar (bukan berawalan penanda) agar pencarian direktori berbasis prefix nama terukur realistis.
 *
 * Penolakan production dan konfirmasi nama database dilakukan CLI (`loadtest-seed.ts`); modul ini juga menolak bila
 * dataset sudah ada (jalankan ulang hanya pada database staging yang direset) kecuali mode tambah payment.
 */
import {
  adminPermissions,
  admins,
  alumni,
  alumniProfessions,
  alumniSkills,
  appSettings,
  events,
  masterProfessions,
  masterSkills,
  messages,
  mfaTotp,
  payments,
  posts,
  roomMembers,
  rooms,
  users,
} from "@kapdh/database";
import bcrypt from "bcryptjs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { rows } from "../core/db/rows.js";
import type { Db } from "../core/db/types.js";
import { encryptSecret, newTotpSecret } from "../core/identity/crypto.js";
import { type Gender, memberNumber } from "../core/membership/member-number.js";
import { addCalendarMonthsJakarta } from "../core/membership/period.js";

export const LOADTEST_EMAIL_DOMAIN = "uji-beban.kapdh.test";
export const LOADTEST_MARK = "[Uji Beban]";
const DAY_MS = 24 * 3600_000;
const BATCH = 500;

export interface LoadDatasetOptions {
  /** Jumlah profil alumni aktif seluruhnya (termasuk akun login). PRD 2.4: 5.000. */
  profiles: number;
  /** Akun anggota yang kredensialnya diberikan ke alat beban (sesi anggota). PRD 2.4: 100. */
  loginMembers: number;
  /** Admin ber-TOTP dengan izin payments.read/decide dan members.read. PRD 2.4: 5. */
  admins: number;
  /** Total pesan chat riwayat. PRD 2.4: 100.000. */
  messages: number;
  /** Room grup (termasuk room realtime: satu per 10 akun login). */
  groupRooms: number;
  /** Room langsung (direct). */
  directRooms: number;
  /** Event gratis terbuka untuk reservasi. */
  events: number;
  /** Payment renewal menunggu keputusan (bukti versi 1) milik profil non-login. */
  pendingPayments: number;
  /** Berita terbit. */
  posts: number;
  /** Sandi akun anggota login dan admin (dibangkitkan CLI; tidak pernah dicetak). */
  memberPassword: string;
  adminPassword: string;
  bcryptCost: number;
  totpEncKey: string;
  now: Date;
  /** Benih acak deterministik (pengulangan dataset yang sama). */
  seed?: number;
  onProgress?: (message: string) => void;
}

export const DEFAULT_LOAD_DATASET = {
  profiles: 5000,
  loginMembers: 100,
  admins: 5,
  messages: 100_000,
  groupRooms: 40,
  directRooms: 200,
  events: 20,
  pendingPayments: 1000,
  posts: 30,
} as const;

/** Kredensial untuk infra/loadtest (berkas 0600, hanya staging). */
export interface LoadCredentials {
  kind: "kapdh.loadtest_credentials";
  version: 1;
  dataset_id: string;
  created_at: string;
  counts: Record<string, number>;
  member_password: string;
  members: { email: string; user_id: string }[];
  admins: { email: string; password: string; totp_secret: string; admin_id: string }[];
  realtime_room_ids: string[];
  event_ids: string[];
}

export class LoadDatasetRefusedError extends Error {
  override name = "LoadDatasetRefusedError";
}

/** PRNG kecil deterministik (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Ahmad",
  "Muhammad",
  "Abdullah",
  "Fauzi",
  "Hasan",
  "Husain",
  "Ilham",
  "Rizki",
  "Fajar",
  "Yusuf",
  "Hafiz",
  "Arif",
  "Bayu",
  "Dimas",
  "Faisal",
  "Hamzah",
  "Irfan",
  "Lutfi",
  "Nabil",
  "Rahmat",
  "Siti",
  "Aisyah",
  "Fatimah",
  "Khadijah",
  "Nurul",
  "Zahra",
  "Annisa",
  "Laila",
  "Maryam",
  "Rahma",
  "Salma",
  "Ulfa",
  "Zainab",
  "Hana",
  "Dewi",
];
const LAST_NAMES = [
  "Hidayat",
  "Rahman",
  "Syahputra",
  "Nugraha",
  "Permana",
  "Firmansyah",
  "Maulana",
  "Saputra",
  "Hakim",
  "Ramadhan",
  "Kurniawan",
  "Wibowo",
  "Setiawan",
  "Pratama",
  "Hasibuan",
  "Lubis",
  "Siregar",
  "Nasution",
  "Harahap",
  "Azizah",
  "Rahmawati",
  "Fitriani",
  "Lestari",
  "Wulandari",
  "Kusuma",
  "Anwar",
  "Basri",
  "Iskandar",
  "Zulkifli",
  "Munir",
];
const CITIES = [
  "Bogor",
  "Jakarta",
  "Bandung",
  "Depok",
  "Bekasi",
  "Tangerang",
  "Sukabumi",
  "Cianjur",
  "Serang",
  "Cirebon",
  "Semarang",
  "Yogyakarta",
  "Surabaya",
  "Malang",
  "Medan",
  "Padang",
  "Palembang",
  "Makassar",
  "Balikpapan",
  "Pekanbaru",
];
/** Pasangan kelas masuk/keluar yang sah (1-3 MTs, 4-6 Aliyah). */
const CLASS_PAIRS: [number, number][] = [
  [1, 6],
  [1, 6],
  [1, 6],
  [1, 3],
  [4, 6],
  [1, 4],
  [2, 6],
  [3, 6],
  [1, 2],
  [4, 5],
];

function chunks<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function assertPositive(name: string, value: number, min = 0): void {
  if (!Number.isInteger(value) || value < min)
    throw new LoadDatasetRefusedError(`${name} harus bilangan bulat >= ${min}`);
}

/** Validasi ukuran dataset (galat aman dicetak). */
export function validateLoadDatasetOptions(o: LoadDatasetOptions): void {
  assertPositive("profiles", o.profiles, 2);
  assertPositive("loginMembers", o.loginMembers, 2);
  assertPositive("admins", o.admins, 1);
  assertPositive("messages", o.messages);
  assertPositive("groupRooms", o.groupRooms, 1);
  assertPositive("directRooms", o.directRooms);
  assertPositive("events", o.events, 1);
  assertPositive("pendingPayments", o.pendingPayments);
  assertPositive("posts", o.posts);
  if (o.loginMembers > o.profiles) throw new LoadDatasetRefusedError("loginMembers melebihi profiles");
  if (o.pendingPayments > o.profiles - o.loginMembers)
    throw new LoadDatasetRefusedError("pendingPayments melebihi jumlah profil non-login");
  if (o.groupRooms < Math.ceil(o.loginMembers / 10))
    throw new LoadDatasetRefusedError("groupRooms minimal satu room realtime per 10 akun login");
}

/** Jumlah akun dataset uji beban yang sudah ada. */
export async function countLoadUsers(db: Db): Promise<number> {
  const [row] = rows<{ n: string }>(
    await db.execute(
      sql`select count(*)::text as n from app.users where email like ${`%@${LOADTEST_EMAIL_DOMAIN}`}`,
    ),
  );
  return Number(row?.n ?? 0);
}

async function currentPolicyVersion(db: Db): Promise<string> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "legal"));
  const legal = row?.value as { privacy_version?: string | null; terms_version?: string | null } | undefined;
  return legal?.privacy_version && legal?.terms_version
    ? `privacy:${legal.privacy_version};terms:${legal.terms_version}`
    : "privacy:1;terms:1";
}

interface Profile {
  userId: string;
  email: string;
  fullName: string;
  gender: Gender;
  cohort: number;
  classIn: number;
  classOut: number;
  city: string;
  login: boolean;
}

/**
 * Membangun dataset lengkap. Mengembalikan kredensial untuk alat beban; sandi hanya ada di objek ini (CLI menulisnya
 * ke berkas 0600). Idempotensi: menolak bila akun dataset sudah ada.
 */
export async function seedLoadDataset(db: Db, o: LoadDatasetOptions): Promise<LoadCredentials> {
  validateLoadDatasetOptions(o);
  const progress = o.onProgress ?? (() => undefined);
  if ((await countLoadUsers(db)) > 0)
    throw new LoadDatasetRefusedError(
      `Dataset uji beban (@${LOADTEST_EMAIL_DOMAIN}) sudah ada. Reset database staging lebih dahulu, atau pakai --top-up-payments.`,
    );
  const random = rng(o.seed ?? 20261014);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const now = o.now;
  const datasetId = `uji-beban-${now.toISOString().slice(0, 10)}-${uuidv7().slice(-6)}`;
  const policyVersion = await currentPolicyVersion(db);
  const memberHash = await bcrypt.hash(o.memberPassword, o.bcryptCost);
  const adminHash = await bcrypt.hash(o.adminPassword, o.bcryptCost);

  // ------------------------------------------------------------------------------------------- profil
  progress(`profil: ${o.profiles} (akun login ${o.loginMembers})`);
  const profiles: Profile[] = [];
  for (let i = 0; i < o.profiles; i++) {
    const [classIn, classOut] = pick(CLASS_PAIRS);
    const female = random() < 0.45;
    const first = female ? pick(FIRST_NAMES.slice(20)) : pick(FIRST_NAMES.slice(0, 20));
    const n = String(i + 1).padStart(5, "0");
    profiles.push({
      userId: uuidv7(),
      email: `${i < o.loginMembers ? "anggota" : "profil"}-${n}@${LOADTEST_EMAIL_DOMAIN}`,
      fullName: `${first} ${pick(LAST_NAMES)}`,
      gender: female ? "female" : "male",
      cohort: 1 + Math.floor(random() * 30),
      classIn,
      classOut,
      city: pick(CITIES),
      login: i < o.loginMembers,
    });
  }
  const professionIds = (await db.select({ id: masterProfessions.id }).from(masterProfessions)).map(
    (r) => r.id,
  );
  const skillIds = (await db.select({ id: masterSkills.id }).from(masterSkills)).map((r) => r.id);
  const startsAt = new Date(now.getTime() - 60 * DAY_MS);
  const expiresAt = addCalendarMonthsJakarta(startsAt, 12);
  for (const batch of chunks(profiles)) {
    await db.transaction(async (tx) => {
      await tx.insert(users).values(
        batch.map((p) => ({
          id: p.userId,
          email: p.email,
          passwordHash: memberHash,
          status: "active" as const,
          kind: "alumni",
          emailVerifiedAt: now,
          policyVersion,
          policyAcceptedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
      // Nomor anggota: nextval lalu INSERT pada sesi/transaksi yang sama tanpa nextval lain (trigger 0004).
      for (const p of batch) {
        const [next] = rows<{ seq: string }>(
          await tx.execute(sql`select nextval('app.membership_no_seq')::text as seq`),
        );
        const seq = Number(next!.seq);
        await tx.insert(alumni).values({
          userId: p.userId,
          fullName: p.fullName,
          gender: p.gender,
          cohort: p.cohort,
          classIn: p.classIn,
          classOut: p.classOut,
          city: p.city,
          bio: `${LOADTEST_MARK} data sintetis uji beban, bukan alumni nyata.`,
          showInDirectory: true,
          memberSeq: seq,
          memberNumber: memberNumber({ ...p, seq }),
          startsAt,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (professionIds.length > 0)
        await tx
          .insert(alumniProfessions)
          .values(
            batch.map((p) => ({ alumniUserId: p.userId, professionId: pick(professionIds), createdAt: now })),
          );
      if (skillIds.length > 0)
        await tx
          .insert(alumniSkills)
          .values(batch.map((p) => ({ alumniUserId: p.userId, skillId: pick(skillIds), createdAt: now })));
    });
  }

  // ------------------------------------------------------------------------------------------- admin
  progress(`admin: ${o.admins}`);
  const adminCreds: LoadCredentials["admins"] = [];
  for (let i = 0; i < o.admins; i++) {
    const userId = uuidv7();
    const adminId = uuidv7();
    const totpSecret = newTotpSecret();
    const email = `admin-${String(i + 1).padStart(2, "0")}@${LOADTEST_EMAIL_DOMAIN}`;
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email,
        passwordHash: adminHash,
        status: "active",
        kind: "admin",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(admins).values({
        id: adminId,
        userId,
        linkedAlumniUserId: null,
        displayName: `${LOADTEST_MARK} Admin ${i + 1}`,
        role: "admin",
        status: "active",
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(adminPermissions).values(
        (["payments.read", "payments.decide", "members.read"] as const).map((permission) => ({
          adminId,
          permission,
          createdAt: now,
        })),
      );
      await tx.insert(mfaTotp).values({
        userId,
        secretEncrypted: encryptSecret(totpSecret, o.totpEncKey),
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    adminCreds.push({ email, password: o.adminPassword, totp_secret: totpSecret, admin_id: adminId });
  }

  // ------------------------------------------------------------------------------------------- room chat
  const login = profiles.filter((p) => p.login);
  const others = profiles.filter((p) => !p.login);
  const joinedAt = new Date(now.getTime() - 120 * DAY_MS);
  type RoomPlan = {
    id: string;
    kind: "group" | "direct";
    name: string | null;
    directKey: string | null;
    members: string[];
    weight: number;
  };
  const plans: RoomPlan[] = [];
  const realtimeRooms = Math.ceil(login.length / 10);
  for (let r = 0; r < o.groupRooms; r++) {
    const members = new Set<string>();
    if (r < realtimeRooms) {
      // Room realtime (N-02): 10 akun login + profil lain sampai 50 anggota (fan-out ke penerima offline).
      for (const p of login.slice(r * 10, r * 10 + 10)) members.add(p.userId);
      const target = Math.min(50, members.size + others.length);
      while (members.size < target) members.add(pick(others).userId);
    } else {
      while (members.size < Math.min(30, profiles.length)) members.add(pick(profiles).userId);
      // Setiap akun login juga anggota beberapa grup biasa (daftar room yang realistis).
      for (const p of login)
        if (random() < 2 / Math.max(1, o.groupRooms - realtimeRooms)) members.add(p.userId);
    }
    plans.push({
      id: uuidv7(),
      kind: "group",
      name: r < realtimeRooms ? `${LOADTEST_MARK} Realtime ${r + 1}` : `${LOADTEST_MARK} Grup ${r + 1}`,
      directKey: null,
      members: [...members],
      // Dua grup pertama non-realtime menjadi room "besar" untuk paging riwayat yang dalam.
      weight: r >= realtimeRooms && r < realtimeRooms + 2 ? 30 : 3,
    });
  }
  const directKeys = new Set<string>();
  for (let d = 0; d < o.directRooms; d++) {
    const a = d % 2 === 0 ? pick(login).userId : pick(profiles).userId;
    const b = pick(profiles).userId;
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (directKeys.has(key)) continue;
    directKeys.add(key);
    plans.push({ id: uuidv7(), kind: "direct", name: null, directKey: key, members: [a, b], weight: 1 });
  }
  progress(`room: ${plans.length} (realtime ${realtimeRooms})`);
  const totalWeight = plans.reduce((s, p) => s + p.weight, 0);
  const perRoom = plans.map((p) => Math.floor((o.messages * p.weight) / totalWeight));
  perRoom[0]! += o.messages - perRoom.reduce((s, n) => s + n, 0);
  const historyStart = now.getTime() - 90 * DAY_MS;
  const historyEnd = now.getTime() - 3600_000;
  for (const [index, plan] of plans.entries()) {
    const count = perRoom[index]!;
    const times = Array.from(
      { length: count },
      () => historyStart + random() * (historyEnd - historyStart),
    ).sort((x, y) => x - y);
    const lastMessageAt = times.length > 0 ? new Date(times[times.length - 1]!) : null;
    await db.transaction(async (tx) => {
      await tx.insert(rooms).values({
        id: plan.id,
        kind: plan.kind,
        directKey: plan.directKey,
        name: plan.name,
        createdBy: plan.members[0]!,
        lastMessageAt,
        createdAt: joinedAt,
        updatedAt: lastMessageAt ?? joinedAt,
      });
      await tx.insert(roomMembers).values(
        plan.members.map((userId, i) => ({
          roomId: plan.id,
          userId,
          role: plan.kind === "group" && i === 0 ? ("admin" as const) : ("member" as const),
          status: "joined" as const,
          joinedAt,
          historyVisibleFrom: joinedAt,
          createdAt: joinedAt,
          updatedAt: joinedAt,
        })),
      );
      const rowsToInsert = times.map((at, i) => ({
        id: uuidv7(),
        roomId: plan.id,
        senderId: pick(plan.members),
        clientMessageId: uuidv7(),
        kind: "text" as const,
        body: `${LOADTEST_MARK} pesan ${i + 1} di room ini`,
        createdAt: new Date(at),
      }));
      for (const batch of chunks(rowsToInsert, 1000)) await tx.insert(messages).values(batch);
    });
  }
  progress(`pesan: ${o.messages}`);

  // ------------------------------------------------------------------------------------------- event & berita
  const eventIds: string[] = [];
  await db.insert(events).values(
    Array.from({ length: o.events }, (_, i) => {
      const id = uuidv7();
      eventIds.push(id);
      const startsAtEvent = new Date(now.getTime() + (90 + i) * DAY_MS);
      return {
        id,
        title: `${LOADTEST_MARK} Kajian dan Silaturahmi ${i + 1}`,
        description: `${LOADTEST_MARK} event sintetis untuk uji reservasi.`,
        locationName: pick(CITIES),
        startsAt: startsAtEvent,
        endsAt: new Date(startsAtEvent.getTime() + 3 * 3600_000),
        registrationOpensAt: new Date(now.getTime() - DAY_MS),
        registrationClosesAt: new Date(now.getTime() + 60 * DAY_MS),
        price: "0",
        seatsTotal: 100_000,
        status: "open" as const,
        createdAt: now,
        updatedAt: now,
      };
    }),
  );
  if (o.posts > 0)
    await db.insert(posts).values(
      Array.from({ length: o.posts }, (_, i) => ({
        id: uuidv7(),
        slug: `uji-beban-${i + 1}-${datasetId.slice(-6)}`,
        title: `${LOADTEST_MARK} Kabar alumni ${i + 1}`,
        excerpt: `${LOADTEST_MARK} ringkasan berita sintetis.`,
        bodyHtml: `<p>${LOADTEST_MARK} isi berita sintetis ${i + 1}.</p>`,
        status: "published" as const,
        publishedAt: new Date(now.getTime() - (i + 1) * 3600_000),
        createdAt: now,
        updatedAt: now,
      })),
    );
  progress(`event: ${o.events}, berita: ${o.posts}`);

  // ------------------------------------------------------------------------------------------- payment
  const paymentCount = await addPendingRenewals(
    db,
    others.map((p) => p.userId),
    o.pendingPayments,
    now,
  );
  progress(`payment renewal menunggu keputusan: ${paymentCount}`);

  return {
    kind: "kapdh.loadtest_credentials",
    version: 1,
    dataset_id: datasetId,
    created_at: now.toISOString(),
    counts: {
      profiles: o.profiles,
      login_members: login.length,
      admins: o.admins,
      rooms: plans.length,
      realtime_rooms: realtimeRooms,
      messages: o.messages,
      events: o.events,
      pending_payments: paymentCount,
      posts: o.posts,
    },
    member_password: o.memberPassword,
    members: login.map((p) => ({ email: p.email, user_id: p.userId })),
    admins: adminCreds,
    realtime_room_ids: plans.slice(0, realtimeRooms).map((p) => p.id),
    event_ids: eventIds,
  };
}

/**
 * Payment renewal `pending` dengan bukti versi 1 (antrean keputusan admin, AC F04-3) untuk kandidat yang belum
 * memiliki payment iuran terbuka (payments_user_id_type_open_key). Dipakai juga mode `--top-up-payments` setelah
 * antrean habis diputus uji beban sebelumnya.
 */
export async function addPendingRenewals(
  db: Db,
  candidateUserIds: readonly string[],
  count: number,
  now: Date,
): Promise<number> {
  if (count <= 0 || candidateUserIds.length === 0) return 0;
  const [fees] = await db
    .select({ version: appSettings.version })
    .from(appSettings)
    .where(eq(appSettings.key, "fees"));
  const open = new Set<string>();
  for (const batch of chunks(candidateUserIds, 1000)) {
    const found = await db
      .select({ userId: payments.userId })
      .from(payments)
      .where(
        and(
          inArray(payments.userId, batch),
          inArray(payments.status, ["pending", "rejected"]),
          inArray(payments.type, ["registration", "renewal"]),
        ),
      );
    for (const row of found) if (row.userId) open.add(row.userId);
  }
  const targets = candidateUserIds.filter((id) => !open.has(id)).slice(0, count);
  const amount = "10000.00";
  for (const batch of chunks(targets)) {
    await db.insert(payments).values(
      batch.map((userId, i) => {
        const submittedAt = new Date(now.getTime() - ((i % 72) + 1) * 3600_000);
        return {
          id: uuidv7(),
          userId,
          type: "renewal" as const,
          status: "pending" as const,
          amount,
          linesSnapshot: [{ code: "renewal", label: `${LOADTEST_MARK} Iuran perpanjangan`, amount }],
          methodSnapshot: {
            kind: "bank",
            provider: `${LOADTEST_MARK} Bank Contoh`,
            account_number: "7000000000",
            account_holder: "KAPDH (uji beban)",
          },
          settingsVersion: fees?.version ?? 1,
          proofVersion: 1,
          transferNote: `${LOADTEST_MARK} bukti sintetis`,
          submittedAt,
          createdAt: submittedAt,
          updatedAt: submittedAt,
        };
      }),
    );
  }
  return targets.length;
}

/** Profil dataset non-login (kandidat top-up payment). */
export async function loadProfileUserIds(db: Db): Promise<string[]> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(and(like(users.email, `profil-%@${LOADTEST_EMAIL_DOMAIN}`), eq(users.kind, "alumni")));
  return found.map((r) => r.id);
}
