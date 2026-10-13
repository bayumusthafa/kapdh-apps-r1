import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import {
  alumni,
  alumniProfessions,
  alumniSkills,
  blocks,
  files,
  masterProfessions,
  masterSkills,
  roomMembers,
  rooms,
  users,
} from "@kapdh/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db, DbOrTx } from "../../core/db/types.js";
import { AppException, notFound } from "../../core/errors/app-exception.js";
import type { FileAccessPolicy } from "../../core/files/access-policy.js";
import { FilesService } from "../../core/files/files.service.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { hasActiveMembership } from "../../core/membership/effective-status.js";
import { COHORT_BASE_YEAR, cohortCode } from "../../core/membership/member-number.js";
import { decodeCursor, encodeCursor, parsePageQuery } from "../../core/pagination/cursor.js";
import { BlockPolicy } from "../../core/policy/block.policy.js";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { queryInt, UUID_PATTERN, validateQuery } from "../../core/validation/validate.js";
import {
  type DirectoryFilters,
  type DirectoryPosition,
  type DirectorySort,
  directoryCountQuery,
  directoryPageQuery,
  directoryVisible,
  notBlockedByOwner,
} from "./directory.query.js";

type DirectoryPage = components["schemas"]["DirectoryPage"];
type DirectoryMember = components["schemas"]["DirectoryMember"];
type NetworkMemberProfile = components["schemas"]["NetworkMemberProfile"];
type NetworkMasterRef = components["schemas"]["NetworkMasterRef"];

/**
 * Batas laju anti-scraping per anggota (kontrak searchDirectory/getMemberProfile 429; PRD 3.10 privasi, N-15).
 * Jendela pendek menahan lonjakan, jendela per jam menahan pengumpulan massal; nilai final mengikuti D1/D8.
 */
export const DIRECTORY_RATE_LIMITS = {
  search: [
    { limit: 60, windowMs: 60_000 },
    { limit: 600, windowMs: 3600_000 },
  ],
  profile: [
    { limit: 120, windowMs: 60_000 },
    { limit: 1200, windowMs: 3600_000 },
  ],
} as const;

/** Kunci kuota per anggota per jendela; RateLimitService meng-hash kunci sebelum disimpan. */
export function directoryRateLimitKey(
  kind: keyof typeof DIRECTORY_RATE_LIMITS,
  windowMs: number,
  userId: string,
): string {
  return `network:${kind}:${windowMs}:${userId}`;
}

const uuidString = (message = "Format id tidak valid") =>
  z
    .string()
    .regex(UUID_PATTERN, message)
    .transform((value) => value.toLowerCase());

/** Query GET /directory (kontrak searchDirectory). cursor/limit dibaca parsePageQuery. */
const searchQuerySchema = z.object({
  q: z
    .string({ message: "Kata kunci tidak valid" })
    .max(100, "Maksimal 100 karakter")
    .trim()
    .min(2, "Kata kunci minimal 2 karakter")
    .optional(),
  cohort: queryInt({ min: 1, max: 99 }).optional(),
  class_level: queryInt({ min: 1, max: 6 }).optional(),
  city: z
    .string({ message: "Kota tidak valid" })
    .max(80, "Maksimal 80 karakter")
    .trim()
    .min(1, "Kota tidak boleh kosong")
    .optional(),
  profession_id: uuidString().optional(),
  skill_id: uuidString().optional(),
  sort: z.enum(["name_asc", "cohort_desc"], { message: "Gunakan name_asc atau cohort_desc" }).optional(),
});

const positionSchema = z.discriminatedUnion("s", [
  z.object({ s: z.literal("name_asc"), n: z.string().max(1000), id: uuidString() }),
  z.object({
    s: z.literal("cohort_desc"),
    c: z.number().int().min(1).max(99),
    n: z.string().max(1000),
    id: uuidString(),
  }),
]);

/** Cursor dari urutan lain tidak boleh dipakai (paging tanpa duplikasi, AC F10-1); galat sama dengan decodeCursor. */
const cursorMismatch = () =>
  new AppException(400, "VALIDATION_ERROR", "Parameter pencarian tidak valid.", {
    fieldErrors: { cursor: ["Cursor tidak valid. Muat ulang daftar dari awal."] },
  });

interface CardRow {
  userId: string;
  fullName: string;
  cohort: number;
  city: string | null;
  lastEducationInstitution: string | null;
  lastEducationCity: string | null;
  avatarFileId: string | null;
}

interface MasterRefs {
  profession: Map<string, NetworkMasterRef>;
  skills: Map<string, NetworkMasterRef[]>;
}

/**
 * Direktori dan profil anggota lain (F-10, PRD 3.10, ARCHITECTURE §3.5). Hanya-baca: tidak ada operasi yang mengubah
 * profil siapa pun (AC F10-5; profil sendiri diubah lewat PATCH /me/profile milik modul membership).
 */
@Injectable()
export class DirectoryService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly files: FilesService,
    private readonly blockPolicy: BlockPolicy,
    private readonly rateLimits: RateLimitService,
  ) {}

  /**
   * Avatar privat anggota lain hanya dapat dibuka anggota aktif yang memang dapat melihat profil pemiliknya di
   * direktori (PRD 5.4, N-09): kebijakan dievaluasi ulang setiap kali URL bertanda tangan dibuka, sehingga suspend,
   * expired, show_in_directory=false, blokir oleh pemilik, atau penggantian avatar langsung mematikan URL yang beredar.
   */
  onModuleInit(): void {
    this.files.registerAccessPolicy("avatar", this.directoryAvatarPolicy);
  }

  private readonly directoryAvatarPolicy: FileAccessPolicy = async ({ file, viewer, db }) => {
    if (viewer.audience !== "mobile" || !viewer.effectiveStatus) return false;
    if (!hasActiveMembership(viewer.effectiveStatus)) return false;
    const [owner] = await db
      .select({ userId: alumni.userId })
      .from(alumni)
      .innerJoin(users, eq(users.id, alumni.userId))
      .where(
        and(
          eq(alumni.avatarFileId, file.id),
          directoryVisible(this.clock.now()),
          notBlockedByOwner(db, viewer.userId),
        ),
      )
      .limit(1);
    return owner !== undefined;
  };

  // ------------------------------------------------------------------------------------------------ pencarian

  /**
   * GET /directory (AC F10-1, F10-2, F10-3): hasil dan total dari SATU snapshot (repeatable read, hanya-baca)
   * sehingga total selalu konsisten dengan halaman; urutan keyset stabil tanpa duplikasi antarhalaman.
   */
  async search(auth: AuthContext, query: unknown): Promise<DirectoryPage> {
    await this.consume("search", auth.userId);
    const page = parsePageQuery(query);
    const params = validateQuery(searchQuerySchema, query);
    const sort: DirectorySort = params.sort ?? "name_asc";
    const after = page.cursor ? decodeCursor(page.cursor, positionSchema) : null;
    if (after && after.s !== sort) throw cursorMismatch();
    const filters: DirectoryFilters = {
      nameTokens: params.q ? [...new Set(params.q.split(/\s+/).filter((token) => token.length > 0))] : [],
      cohort: params.cohort,
      classLevel: params.class_level,
      city: params.city,
      professionId: params.profession_id,
      skillId: params.skill_id,
    };
    const now = this.clock.now();

    return this.db.transaction(
      async (tx) => {
        const found = await directoryPageQuery(tx, {
          viewerId: auth.userId,
          filters,
          now,
          sort,
          after,
          limit: page.limit,
        });
        const [counted] = await directoryCountQuery(tx, { viewerId: auth.userId, filters, now });
        const hasMore = found.length > page.limit;
        const pageRows = hasMore ? found.slice(0, page.limit) : found;
        const masters = await this.masterRefs(
          tx,
          pageRows.map((row) => row.userId),
        );
        const avatars = await this.avatarUrls(tx, pageRows, auth);
        const items = pageRows.map((row) => this.toCard(row, masters, avatars));
        const last = pageRows[pageRows.length - 1];
        const position: DirectoryPosition | null =
          !hasMore || !last
            ? null
            : sort === "name_asc"
              ? { s: "name_asc", n: last.sortName, id: last.userId }
              : { s: "cohort_desc", c: last.cohort, n: last.sortName, id: last.userId };
        return {
          items,
          total: Number(counted?.total ?? 0),
          next_cursor: position ? encodeCursor(position) : null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private toCard(row: CardRow, masters: MasterRefs, avatars: Map<string, string>): DirectoryMember {
    return {
      user_id: row.userId,
      full_name: row.fullName,
      avatar_url: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
      cohort: row.cohort,
      cohort_code: cohortCode(row.cohort),
      city: row.city,
      profession: masters.profession.get(row.userId) ?? null,
      last_education_institution: row.lastEducationInstitution,
      last_education_city: row.lastEducationCity,
      skills: masters.skills.get(row.userId) ?? [],
    };
  }

  // -------------------------------------------------------------------------------------------------- profil

  /**
   * GET /directory/{userId} (AC F10-2, F10-4): profil anggota yang tampil di direktori dan tidak memblokir pemanggil,
   * atau profil sendiri (pratinjau); selain itu 404 tanpa membedakan alasan (N-09). Kontak hanya dikirim bila flag
   * pemiliknya aktif: kuncinya tidak ada sama sekali bila mati (AC F10-2).
   */
  async profile(auth: AuthContext, userId: string): Promise<NetworkMemberProfile> {
    await this.consume("profile", auth.userId);
    const isMe = userId === auth.userId;
    const now = this.clock.now();

    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select({
            userId: alumni.userId,
            fullName: alumni.fullName,
            cohort: alumni.cohort,
            city: alumni.city,
            lastEducationInstitution: alumni.lastEducationInstitution,
            lastEducationCity: alumni.lastEducationCity,
            avatarFileId: alumni.avatarFileId,
            bio: alumni.bio,
            phone: alumni.phone,
            email: users.email,
            socialInstagram: alumni.socialInstagram,
            socialX: alumni.socialX,
            socialFacebook: alumni.socialFacebook,
            socialLinkedin: alumni.socialLinkedin,
            showEmail: alumni.showEmail,
            showPhone: alumni.showPhone,
            showSocial: alumni.showSocial,
          })
          .from(alumni)
          .innerJoin(users, eq(users.id, alumni.userId))
          .where(
            and(
              eq(alumni.userId, userId),
              isMe
                ? eq(users.status, "active")
                : and(directoryVisible(now), notBlockedByOwner(tx, auth.userId)),
            ),
          )
          .limit(1);
        if (!row) throw notFound("Profil anggota tidak ditemukan.");

        const masters = await this.masterRefs(tx, [row.userId]);
        const avatars = await this.avatarUrls(tx, [row], auth);
        const isBlockedByMe = isMe ? false : await this.blockedBy(tx, auth.userId, row.userId);
        // can_message: false bila salah satu pihak memblokir atau profil sendiri; alasan tidak dibedakan (AC F12-1).
        const canMessage =
          !isMe &&
          !isBlockedByMe &&
          !(await this.blockPolicy.isBlockedEitherWay(auth.userId, row.userId, tx));
        const directRoomId = isMe ? null : await this.directRoomId(tx, auth.userId, row.userId);

        const profile: NetworkMemberProfile = {
          user_id: row.userId,
          full_name: row.fullName,
          avatar_url: row.avatarFileId ? (avatars.get(row.avatarFileId) ?? null) : null,
          cohort: row.cohort,
          cohort_code: cohortCode(row.cohort),
          graduation_year: COHORT_BASE_YEAR + row.cohort,
          city: row.city,
          profession: masters.profession.get(row.userId) ?? null,
          skills: masters.skills.get(row.userId) ?? [],
          last_education_institution: row.lastEducationInstitution,
          last_education_city: row.lastEducationCity,
          bio: row.bio,
          is_me: isMe,
          is_blocked_by_me: isBlockedByMe,
          can_message: canMessage,
          direct_room_id: directRoomId,
        };
        // Field privat: kunci hanya ditambahkan bila flag pemilik aktif (AC F10-2, N-15).
        if (row.showEmail) profile.email = row.email;
        if (row.showPhone) profile.phone = row.phone;
        if (row.showSocial)
          profile.social = {
            instagram: row.socialInstagram,
            x: row.socialX,
            facebook: row.socialFacebook,
            linkedin: row.socialLinkedin,
          };
        return profile;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  private async blockedBy(db: DbOrTx, blockerId: string, blockedId: string): Promise<boolean> {
    const [row] = await db
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedId)))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Room direct yang sudah ada dan pemanggil masih anggota joined-nya (tombol "Kirim Pesan" langsung membuka
   * percakapan; null → klien memanggil POST /chat/direct). direct_key kanonik min(a,b):max(a,b) (AC F11-1); kedua urutan
   * dicari agar tidak bergantung pada aturan perbandingan string.
   */
  private async directRoomId(db: DbOrTx, viewerId: string, peerId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .innerJoin(
        roomMembers,
        and(
          eq(roomMembers.roomId, rooms.id),
          eq(roomMembers.userId, viewerId),
          eq(roomMembers.status, "joined"),
        ),
      )
      .where(
        and(
          eq(rooms.kind, "direct"),
          inArray(rooms.directKey, [`${viewerId}:${peerId}`, `${peerId}:${viewerId}`]),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  // ------------------------------------------------------------------------------------------------ bersama

  private async consume(kind: keyof typeof DIRECTORY_RATE_LIMITS, userId: string): Promise<void> {
    for (const { limit, windowMs } of DIRECTORY_RATE_LIMITS[kind])
      await this.rateLimits.consumeOrThrow(
        directoryRateLimitKey(kind, windowMs, userId),
        limit,
        windowMs,
        "Terlalu banyak permintaan jejaring. Coba lagi beberapa saat lagi.",
      );
  }

  /**
   * Profesi dan keahlian anggota pada halaman, termasuk master nonaktif sebagai label historis dengan active=false
   * (AC F10-4). Keahlian diurutkan menurut label (kontrak DirectoryMember.skills).
   */
  private async masterRefs(db: DbOrTx, userIds: string[]): Promise<MasterRefs> {
    const refs: MasterRefs = { profession: new Map(), skills: new Map() };
    if (userIds.length === 0) return refs;
    const professions = await db
      .select({
        userId: alumniProfessions.alumniUserId,
        id: masterProfessions.id,
        label: masterProfessions.label,
        active: masterProfessions.active,
      })
      .from(alumniProfessions)
      .innerJoin(masterProfessions, eq(masterProfessions.id, alumniProfessions.professionId))
      .where(inArray(alumniProfessions.alumniUserId, userIds));
    for (const { userId, ...ref } of professions) refs.profession.set(userId, ref);
    const skills = await db
      .select({
        userId: alumniSkills.alumniUserId,
        id: masterSkills.id,
        label: masterSkills.label,
        active: masterSkills.active,
      })
      .from(alumniSkills)
      .innerJoin(masterSkills, eq(masterSkills.id, alumniSkills.skillId))
      .where(inArray(alumniSkills.alumniUserId, userIds))
      .orderBy(asc(sql`lower(${masterSkills.label})`), asc(masterSkills.id));
    for (const { userId, ...ref } of skills) {
      const list = refs.skills.get(userId) ?? [];
      list.push(ref);
      refs.skills.set(userId, list);
    }
    return refs;
  }

  /**
   * URL avatar (PRD 5.4): berkas publik → URL tetap; privat → URL bertanda tangan <= 10 menit terikat sesi pemanggil,
   * yang saat dibuka dinilai ulang oleh kebijakan avatar direktori. Berkas yang belum/tidak lagi `ready` → null.
   */
  private async avatarUrls(
    db: DbOrTx,
    owners: Pick<CardRow, "avatarFileId">[],
    auth: AuthContext,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(owners.map((row) => row.avatarFileId).filter((id): id is string => id !== null))];
    const urls = new Map<string, string>();
    if (ids.length === 0) return urls;
    const ready = await db
      .select({ id: files.id, purpose: files.purpose, visibility: files.visibility })
      .from(files)
      .where(and(inArray(files.id, ids), eq(files.status, "ready"), eq(files.purpose, "avatar")));
    for (const file of ready) {
      const { url } = await this.files.signedUrl(file, {
        userId: auth.userId,
        sessionId: auth.sessionId,
        sessionVersion: auth.sessionVersion,
      });
      urls.set(file.id, url);
    }
    return urls;
  }
}
