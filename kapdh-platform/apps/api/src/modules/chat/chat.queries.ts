import { roomMembers, rooms } from "@kapdh/database";
import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ADVISORY_LOCK_NAMESPACES } from "../../core/db/locks.js";
import { rows } from "../../core/db/rows.js";
import type { DbOrTx, Tx } from "../../core/db/types.js";

/**
 * Kueri baca/tulis modul chat (F-11). Kueri mentah memakai nama tabel skema `app` dan:
 * - waktu dikembalikan sebagai string ISO UTC berpresisi milidetik (`iso`), sama untuk driver postgres-js dan PGlite;
 * - perbandingan urutan pesan (created_at, id) SELALU dikerjakan di SQL terhadap baris pesan jangkar, karena created_at
 *   berpresisi mikrodetik (aturan urutan commit C6) sedangkan Date JavaScript hanya milidetik;
 * - parameter selalu di-cast eksplisit (`::uuid`, `::text`, ...) agar tipe tidak bergantung inferensi driver.
 */

export type RoomRow = typeof rooms.$inferSelect;
export type MemberRow = typeof roomMembers.$inferSelect;
export type RoomKind = "direct" | "group";
export type MemberRole = "admin" | "member";
export type MemberStatus = "invited" | "joined" | "left" | "removed" | "declined";
export type MessageKind = "text" | "image" | "system";

/** Ekspresi SQL → string ISO UTC milidetik (null tetap null). */
export const iso = (column: string): SQL =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/** Posisi waktu dalam mikrodetik epoch (teks) untuk cursor keyset yang tidak kehilangan presisi. */
export const micros = (column: string): SQL =>
  sql.raw(`floor(extract(epoch from ${column}) * 1000000)::bigint`);

/** Daftar uuid untuk `in (...)`. */
export const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export const toDate = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

/** Lawan bicara room direct dari direct_key kanonik `min(a,b):max(a,b)` (AC F11-1). */
export function directPeerId(directKey: string | null, viewerId: string): string | null {
  if (!directKey) return null;
  const [a, b] = directKey.split(":");
  if (!a || !b) return null;
  return a === viewerId ? b : a;
}

/** direct_key kanonik untuk pasangan pengguna (AC F11-1, rooms_direct_key_canonical_chk). */
export function directKeyFor(a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a];
  return `${low}:${high}`;
}

// ----------------------------------------------------------------------------------------------- room & anggota

/** Mengunci baris room (SELECT ... FOR UPDATE): kunci pertama setiap transaksi yang menulis pesan (aturan C6). */
export async function lockRoom(tx: Tx, roomId: string): Promise<RoomRow | undefined> {
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for("update");
  return room;
}

export async function findRoom(db: DbOrTx, roomId: string): Promise<RoomRow | undefined> {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return room;
}

export async function findMembership(
  db: DbOrTx,
  roomId: string,
  userId: string,
): Promise<MemberRow | undefined> {
  const [member] = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)))
    .limit(1);
  return member;
}

export async function joinedCount(db: DbOrTx, roomId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined")));
  return Number(row?.value ?? 0);
}

/** Kapasitas grup: anggota joined + undangan tertunda (kontrak: undangan tertunda ikut dihitung). */
export async function seatCount(db: DbOrTx, roomId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), inArray(roomMembers.status, ["joined", "invited"])));
  return Number(row?.value ?? 0);
}

export async function joinedAdminIds(db: DbOrTx, roomId: string): Promise<string[]> {
  const found = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(
      and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "joined"), eq(roomMembers.role, "admin")),
    );
  return found.map((row) => row.userId);
}

/**
 * Mengambil kunci pasangan blokir (ruang nama BlockPolicy.lockPair: `(blockPair, hashtext("min:max"))`) untuk banyak
 * pasangan sekaligus, BERURUTAN menurut nilai kunci sebenarnya sehingga dua transaksi yang mengunci himpunan pasangan
 * beririsan tidak pernah saling menunggu terbalik (tanpa deadlock, juga saat hashtext bertabrakan).
 */
export async function lockPairs(tx: Tx, userId: string, others: readonly string[]): Promise<void> {
  const keys = [...new Set(others.filter((other) => other !== userId).map((other) => directKeyFor(userId, other)))];
  if (keys.length === 0) return;
  const hashes = rows<{ h: number }>(
    await tx.execute(sql`
      select distinct hashtext(v.k) as h from (values ${sql.join(
        keys.map((key) => sql`(${key}::text)`),
        sql`, `,
      )}) v(k) order by 1`),
  );
  for (const { h } of hashes)
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACES.blockPair}::int4, ${h}::int4)`,
    );
}

/** Baris room direct untuk pasangan (direct_key kanonik). */
export async function findDirectRoom(db: DbOrTx, a: string, b: string): Promise<RoomRow | undefined> {
  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.directKey, directKeyFor(a, b)))
    .limit(1);
  return room;
}

// --------------------------------------------------------------------------------------------- ringkasan room

export interface RoomSummaryRow {
  id: string;
  kind: RoomKind;
  name: string | null;
  avatar_file_id: string | null;
  avatar_visibility: string | null;
  avatar_status: string | null;
  direct_key: string | null;
  version: number;
  closed_at: string | null;
  created_at: string;
  last_message_at: string | null;
  activity_us: string;
  my_role: MemberRole;
  muted: boolean;
  history_visible_from: string | null;
  last_read_message_id: string | null;
  member_count: number;
  unread_count: number;
  lm_id: string | null;
  lm_kind: MessageKind | null;
  lm_sender_id: string | null;
  lm_body: string | null;
  lm_has_image: boolean | null;
  lm_deleted: boolean | null;
  lm_created_at: string | null;
  lm_sender_name: string | null;
  lm_sender_status: string | null;
  peer_id: string | null;
  peer_account_status: string | null;
  peer_name: string | null;
  peer_avatar_file_id: string | null;
  peer_avatar_visibility: string | null;
  peer_avatar_status: string | null;
  peer_suspended_at: string | null;
  peer_expires_at: string | null;
  i_block: boolean;
  peer_blocks: boolean;
  peer_last_read_message_id: string | null;
}

export interface RoomSummaryQuery {
  viewerId: string;
  roomId?: string;
  kind?: RoomKind;
  /** Room direct tanpa pesan disembunyikan dari daftar (kontrak listChatRooms). */
  hideEmptyDirect?: boolean;
  /** Keyset menurun (aktivitas mikrodetik, id). */
  before?: { us: string; id: string };
  limit: number;
}

/**
 * Ringkasan room untuk anggota joined (ChatRoomSummary/ChatRoom): unread dibatasi 999 (pesan anggota lain sesudah read
 * cursor dan history_visible_from, tanpa pesan terhapus/sistem), pratinjau pesan terakhir yang terlihat, lawan bicara
 * room direct beserta status blokir dua arah. Urutan aktivitas terakhir menurun (last_message_at, lalu created_at).
 */
export async function roomSummaries(db: DbOrTx, query: RoomSummaryQuery): Promise<RoomSummaryRow[]> {
  const filters: SQL[] = [];
  if (query.roomId) filters.push(sql`and r.id = ${query.roomId}::uuid`);
  if (query.kind) filters.push(sql`and r.kind = ${query.kind}::app.room_kind`);
  if (query.hideEmptyDirect) filters.push(sql`and (r.kind = 'group' or r.last_message_at is not null)`);
  if (query.before)
    filters.push(
      sql`and (${micros("coalesce(r.last_message_at, r.created_at)")}, r.id) < (${query.before.us}::bigint, ${query.before.id}::uuid)`,
    );
  const result = await db.execute(sql`
    select r.id, r.kind::text as kind, r.name, r.avatar_file_id, af.visibility as avatar_visibility,
      af.status as avatar_status, r.direct_key, r.version, ${iso("r.closed_at")} as closed_at,
      ${iso("r.created_at")} as created_at, ${iso("r.last_message_at")} as last_message_at,
      ${micros("coalesce(r.last_message_at, r.created_at)")}::text as activity_us,
      rm.role::text as my_role, rm.muted, ${iso("rm.history_visible_from")} as history_visible_from,
      rm.last_read_message_id,
      (select count(*)::int from app.room_members j where j.room_id = r.id and j.status = 'joined') as member_count,
      (select count(*)::int from (
         select 1 from app.messages u
         where u.room_id = r.id and u.deleted_at is null and u.kind <> 'system'
           and u.sender_id is distinct from rm.user_id
           and (rm.history_visible_from is null or u.created_at >= rm.history_visible_from)
           and (lr.id is null or (u.created_at, u.id) > (lr.created_at, lr.id))
         limit 999) x) as unread_count,
      lm.id as lm_id, lm.kind::text as lm_kind, lm.sender_id as lm_sender_id, lm.body as lm_body,
      (lm.image_file_id is not null) as lm_has_image, (lm.deleted_at is not null) as lm_deleted,
      ${iso("lm.created_at")} as lm_created_at, lma.full_name as lm_sender_name, lmu.status::text as lm_sender_status,
      p.peer_id, pu.status::text as peer_account_status, pa.full_name as peer_name,
      pa.avatar_file_id as peer_avatar_file_id, pf.visibility as peer_avatar_visibility,
      pf.status as peer_avatar_status, ${iso("pa.suspended_at")} as peer_suspended_at,
      ${iso("pa.expires_at")} as peer_expires_at,
      exists(select 1 from app.blocks b where b.blocker_id = rm.user_id and b.blocked_id = p.peer_id) as i_block,
      exists(select 1 from app.blocks b where b.blocker_id = p.peer_id and b.blocked_id = rm.user_id) as peer_blocks,
      prm.last_read_message_id as peer_last_read_message_id
    from app.room_members rm
    join app.rooms r on r.id = rm.room_id
    left join app.files af on af.id = r.avatar_file_id
    left join app.messages lr on lr.id = rm.last_read_message_id
    left join lateral (
      select m.id, m.kind, m.sender_id, m.body, m.image_file_id, m.deleted_at, m.created_at
      from app.messages m
      where m.room_id = r.id and (rm.history_visible_from is null or m.created_at >= rm.history_visible_from)
      order by m.created_at desc, m.id desc
      limit 1) lm on true
    left join app.alumni lma on lma.user_id = lm.sender_id
    left join app.users lmu on lmu.id = lm.sender_id
    left join lateral (
      select case when r.kind = 'direct' then
        (case when split_part(r.direct_key, ':', 1) = rm.user_id::text
              then split_part(r.direct_key, ':', 2) else split_part(r.direct_key, ':', 1) end)::uuid
      end as peer_id) p on true
    left join app.users pu on pu.id = p.peer_id
    left join app.alumni pa on pa.user_id = p.peer_id
    left join app.files pf on pf.id = pa.avatar_file_id
    left join app.room_members prm on prm.room_id = r.id and prm.user_id = p.peer_id
    where rm.user_id = ${query.viewerId}::uuid and rm.status = 'joined' ${sql.join(filters, sql` `)}
    order by coalesce(r.last_message_at, r.created_at) desc, r.id desc
    limit ${query.limit}`);
  return rows<RoomSummaryRow>(result);
}

/** Jumlah undangan grup tertunda dan room yang memiliki pesan belum dibaca (lencana navigasi). */
export async function roomBadges(
  db: DbOrTx,
  viewerId: string,
): Promise<{ pending_invitation_count: number; unread_room_count: number }> {
  const [row] = rows<{ pending_invitation_count: number; unread_room_count: number }>(
    await db.execute(sql`
      select
        (select count(*)::int from app.room_members i join app.rooms ir on ir.id = i.room_id
          where i.user_id = ${viewerId}::uuid and i.status = 'invited' and ir.kind = 'group'
            and ir.closed_at is null) as pending_invitation_count,
        (select count(*)::int from app.room_members rm
          join app.rooms r on r.id = rm.room_id
          left join app.messages lr on lr.id = rm.last_read_message_id
          where rm.user_id = ${viewerId}::uuid and rm.status = 'joined'
            and exists (
              select 1 from app.messages u
              where u.room_id = rm.room_id and u.deleted_at is null and u.kind <> 'system'
                and u.sender_id is distinct from rm.user_id
                and (rm.history_visible_from is null or u.created_at >= rm.history_visible_from)
                and (lr.id is null or (u.created_at, u.id) > (lr.created_at, lr.id)))) as unread_room_count`),
  );
  return {
    pending_invitation_count: row?.pending_invitation_count ?? 0,
    unread_room_count: row?.unread_room_count ?? 0,
  };
}

/** unread_count satu anggota (ChatReadState). */
export async function unreadCount(db: DbOrTx, roomId: string, userId: string): Promise<number> {
  const [row] = rows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from (
        select 1 from app.room_members rm
        join app.messages u on u.room_id = rm.room_id
        left join app.messages lr on lr.id = rm.last_read_message_id
        where rm.room_id = ${roomId}::uuid and rm.user_id = ${userId}::uuid
          and u.deleted_at is null and u.kind <> 'system' and u.sender_id is distinct from rm.user_id
          and (rm.history_visible_from is null or u.created_at >= rm.history_visible_from)
          and (lr.id is null or (u.created_at, u.id) > (lr.created_at, lr.id))
        limit 999) x`),
  );
  return row?.n ?? 0;
}

// ----------------------------------------------------------------------------------------- anggota & undangan

export interface MemberListRow {
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  invited_at: string | null;
  joined_at: string | null;
  last_read_message_id: string | null;
  account_status: string | null;
  full_name: string | null;
  avatar_file_id: string | null;
  avatar_visibility: string | null;
  avatar_status: string | null;
  role_rank: number;
  sort_name: string;
}

export interface MemberListQuery {
  roomId: string;
  status?: "joined" | "invited";
  userIds?: readonly string[];
  /** Keyset naik (peringkat peran, nama, user_id). */
  after?: { r: number; n: string; u: string };
  limit?: number;
}

/** Anggota/undangan room: admin dulu, lalu nama (kontrak listChatRoomMembers); hanya nama dan avatar (N-09). */
export async function memberRows(db: DbOrTx, query: MemberListQuery): Promise<MemberListRow[]> {
  const filters: SQL[] = [];
  if (query.status) filters.push(sql`and rm.status = ${query.status}::app.room_member_status`);
  if (query.userIds) {
    if (query.userIds.length === 0) return [];
    filters.push(sql`and rm.user_id in (${uuidList(query.userIds)})`);
  }
  if (query.after)
    filters.push(
      sql`and (case when rm.role = 'admin' then 0 else 1 end, coalesce(a.full_name, ''), rm.user_id) >
              (${query.after.r}::int, ${query.after.n}::text, ${query.after.u}::uuid)`,
    );
  const limit = query.limit === undefined ? sql`` : sql`limit ${query.limit}`;
  return rows<MemberListRow>(
    await db.execute(sql`
      select rm.user_id, rm.role::text as role, rm.status::text as status, ${iso("rm.invited_at")} as invited_at,
        ${iso("rm.joined_at")} as joined_at, rm.last_read_message_id, u.status::text as account_status,
        a.full_name, a.avatar_file_id, f.visibility as avatar_visibility, f.status as avatar_status,
        (case when rm.role = 'admin' then 0 else 1 end)::int as role_rank, coalesce(a.full_name, '') as sort_name
      from app.room_members rm
      left join app.users u on u.id = rm.user_id
      left join app.alumni a on a.user_id = rm.user_id
      left join app.files f on f.id = a.avatar_file_id
      where rm.room_id = ${query.roomId}::uuid ${sql.join(filters, sql` `)}
      order by case when rm.role = 'admin' then 0 else 1 end, coalesce(a.full_name, ''), rm.user_id
      ${limit}`),
  );
}

export interface InvitationRow {
  room_id: string;
  room_name: string;
  avatar_file_id: string | null;
  avatar_visibility: string | null;
  avatar_status: string | null;
  member_count: number;
  invited_at: string;
  invited_us: string;
  invited_by: string | null;
  inviter_status: string | null;
  inviter_name: string | null;
  inviter_avatar_file_id: string | null;
  inviter_avatar_visibility: string | null;
  inviter_avatar_status: string | null;
}

/** Undangan grup tertunda milik pengguna pada grup yang belum ditutup, terbaru dulu (kontrak listChatInvitations). */
export async function invitationRows(
  db: DbOrTx,
  userId: string,
  options: { before?: { us: string; id: string }; limit: number },
): Promise<InvitationRow[]> {
  const keyset = options.before
    ? sql`and (${micros("rm.invited_at")}, r.id) < (${options.before.us}::bigint, ${options.before.id}::uuid)`
    : sql``;
  return rows<InvitationRow>(
    await db.execute(sql`
      select r.id as room_id, r.name as room_name, r.avatar_file_id, af.visibility as avatar_visibility,
        af.status as avatar_status,
        (select count(*)::int from app.room_members j where j.room_id = r.id and j.status = 'joined') as member_count,
        ${iso("rm.invited_at")} as invited_at, ${micros("rm.invited_at")}::text as invited_us,
        rm.invited_by, iu.status::text as inviter_status, ia.full_name as inviter_name,
        ia.avatar_file_id as inviter_avatar_file_id, iff.visibility as inviter_avatar_visibility,
        iff.status as inviter_avatar_status
      from app.room_members rm
      join app.rooms r on r.id = rm.room_id and r.kind = 'group' and r.closed_at is null
      left join app.files af on af.id = r.avatar_file_id
      left join app.users iu on iu.id = rm.invited_by
      left join app.alumni ia on ia.user_id = rm.invited_by
      left join app.files iff on iff.id = ia.avatar_file_id
      where rm.user_id = ${userId}::uuid and rm.status = 'invited' ${keyset}
      order by rm.invited_at desc, r.id desc
      limit ${options.limit}`),
  );
}

// ------------------------------------------------------------------------------------------------------- pesan

export interface MessageRow {
  id: string;
  room_id: string;
  client_message_id: string | null;
  kind: MessageKind;
  body: string | null;
  image_file_id: string | null;
  reply_to_id: string | null;
  created_at: string;
  deleted_at: string | null;
  sender_id: string | null;
  sender_status: string | null;
  sender_name: string | null;
  sender_avatar_file_id: string | null;
  sender_avatar_visibility: string | null;
  sender_avatar_status: string | null;
  image_mime: string | null;
  image_width: number | null;
  image_height: number | null;
  image_visibility: string | null;
  image_status: string | null;
  reply_id: string | null;
  reply_kind: MessageKind | null;
  reply_body: string | null;
  reply_has_image: boolean | null;
  reply_deleted: boolean | null;
  reply_visible: boolean | null;
  reply_sender_name: string | null;
  reply_sender_status: string | null;
}

/** Arah halaman riwayat (kontrak listChatMessages). */
export type MessageDirection = "latest" | "before" | "after";

export interface MessageQuery {
  roomId: string;
  /**
   * Penampil: membatasi pesan ke history_visible_from miliknya dan menilai ketersediaan pesan yang dibalas. null untuk
   * siaran room (tanpa batas penampil; pemanggil sudah memeriksa keanggotaan).
   */
  viewerId: string | null;
  ids?: readonly string[];
  direction?: MessageDirection;
  anchorId?: string;
  limit?: number;
}

/**
 * Pesan beserta pengirim, berkas gambar, dan pesan yang dibalas. Batas history_visible_from dan ketersediaan balasan
 * dihitung di SQL terhadap keanggotaan penampil (presisi mikrodetik). `latest`/`before` menurun, `after`/`ids` naik.
 */
export async function messageRows(db: DbOrTx, query: MessageQuery): Promise<MessageRow[]> {
  const filters: SQL[] = [];
  let order = sql`m.created_at asc, m.id asc`;
  if (query.ids) {
    if (query.ids.length === 0) return [];
    filters.push(sql`and m.id in (${uuidList(query.ids)})`);
  } else if (query.direction === "before" && query.anchorId) {
    filters.push(
      sql`and (m.created_at, m.id) < (select a.created_at, a.id from app.messages a where a.id = ${query.anchorId}::uuid)`,
    );
    order = sql`m.created_at desc, m.id desc`;
  } else if (query.direction === "after" && query.anchorId) {
    filters.push(
      sql`and (m.created_at, m.id) > (select a.created_at, a.id from app.messages a where a.id = ${query.anchorId}::uuid)`,
    );
  } else {
    order = sql`m.created_at desc, m.id desc`;
  }
  const limit = query.limit === undefined ? sql`` : sql`limit ${query.limit}`;
  const result = await db.execute(sql`
    select m.id, m.room_id, m.client_message_id, m.kind::text as kind, m.body, m.image_file_id, m.reply_to_id,
      ${iso("m.created_at")} as created_at, ${iso("m.deleted_at")} as deleted_at,
      m.sender_id, su.status::text as sender_status, sa.full_name as sender_name,
      sa.avatar_file_id as sender_avatar_file_id, sf.visibility as sender_avatar_visibility,
      sf.status as sender_avatar_status,
      imf.mime as image_mime, imf.width as image_width, imf.height as image_height,
      imf.visibility as image_visibility, imf.status as image_status,
      rp.id as reply_id, rp.kind::text as reply_kind, rp.body as reply_body,
      (rp.image_file_id is not null) as reply_has_image, (rp.deleted_at is not null) as reply_deleted,
      (rp.id is not null and rp.room_id = m.room_id
        and (vm.history_visible_from is null or rp.created_at >= vm.history_visible_from)) as reply_visible,
      rpa.full_name as reply_sender_name, rpu.status::text as reply_sender_status
    from app.messages m
    left join app.room_members vm on vm.room_id = m.room_id and vm.user_id = ${query.viewerId}::uuid
    left join app.users su on su.id = m.sender_id
    left join app.alumni sa on sa.user_id = m.sender_id
    left join app.files sf on sf.id = sa.avatar_file_id
    left join app.files imf on imf.id = m.image_file_id
    left join app.messages rp on rp.id = m.reply_to_id
    left join app.alumni rpa on rpa.user_id = rp.sender_id
    left join app.users rpu on rpu.id = rp.sender_id
    where m.room_id = ${query.roomId}::uuid
      and (${query.viewerId === null ? sql`true` : sql`vm.user_id is not null`})
      and (vm.history_visible_from is null or m.created_at >= vm.history_visible_from)
      ${sql.join(filters, sql` `)}
    order by ${order}
    ${limit}`);
  return rows<MessageRow>(result);
}

/** Fakta akun alumni untuk kelayakan direct/undangan dan status "tersedia" (PRD 2.2, N-09). */
export interface UserFactsRow {
  user_id: string;
  account_status: string;
  full_name: string;
  suspended_at: string | null;
  expires_at: string | null;
  show_in_directory: boolean;
}

export async function alumniFacts(
  db: DbOrTx,
  userIds: readonly string[],
): Promise<Map<string, UserFactsRow>> {
  const found = new Map<string, UserFactsRow>();
  if (userIds.length === 0) return found;
  const result = rows<UserFactsRow>(
    await db.execute(sql`
      select u.id as user_id, u.status::text as account_status, a.full_name,
        ${iso("a.suspended_at")} as suspended_at, ${iso("a.expires_at")} as expires_at, a.show_in_directory
      from app.users u join app.alumni a on a.user_id = u.id
      where u.kind = 'alumni' and u.id in (${uuidList(userIds)})`),
  );
  for (const row of result) found.set(row.user_id, row);
  return found;
}

/** true bila kedua pengguna pernah sama-sama menjadi anggota joined satu grup (kontrak openDirectRoom). */
export async function sharedGroupHistory(db: DbOrTx, a: string, b: string): Promise<boolean> {
  const [row] = rows<{ ok: boolean }>(
    await db.execute(sql`
      select true as ok from app.room_members x
      join app.room_members y on y.room_id = x.room_id
      join app.rooms r on r.id = x.room_id and r.kind = 'group'
      where x.user_id = ${a}::uuid and y.user_id = ${b}::uuid
        and x.joined_at is not null and y.joined_at is not null
      limit 1`),
  );
  return row?.ok === true;
}

/** Blokir antara `userId` dan kandidat: himpunan kandidat yang memblokir atau diblokir (dua arah, F-12). */
export async function blockedAmong(
  db: DbOrTx,
  userId: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const found = rows<{ blocker_id: string; blocked_id: string }>(
    await db.execute(sql`
      select b.blocker_id, b.blocked_id from app.blocks b
      where (b.blocker_id = ${userId}::uuid and b.blocked_id in (${uuidList(candidates)}))
         or (b.blocked_id = ${userId}::uuid and b.blocker_id in (${uuidList(candidates)}))`),
  );
  return new Set(found.map((row) => (row.blocker_id === userId ? row.blocked_id : row.blocker_id)));
}

/**
 * Melepas berkas yang tidak dipakai lagi oleh chat (gambar pesan yang dihapus, avatar grup yang diganti) KECUALI masih
 * dirujuk bukti laporan: bukti laporan tidak ikut terhapus (PRD 3.12; kontrak admin-moderation "berkas yang dirujuk
 * bukti ditahan selama laporan disimpan"). true bila berkas masih ditahan.
 */
export async function referencedByReportEvidence(db: DbOrTx, fileId: string): Promise<boolean> {
  const [row] = rows<{ ok: boolean }>(
    await db.execute(sql`
      select true as ok from app.reports
      where evidence is not null and strpos(evidence::text, ${fileId}::text) > 0
      limit 1`),
  );
  return row?.ok === true;
}

/** true bila pesan ada di room dan terlihat bagi pengguna (created_at >= history_visible_from miliknya). */
export async function isMessageVisible(
  db: DbOrTx,
  roomId: string,
  messageId: string,
  viewerId: string,
): Promise<boolean> {
  const [row] = rows<{ ok: boolean }>(
    await db.execute(sql`
      select true as ok from app.messages m
      join app.room_members vm on vm.room_id = m.room_id and vm.user_id = ${viewerId}::uuid
      where m.id = ${messageId}::uuid and m.room_id = ${roomId}::uuid
        and (vm.history_visible_from is null or m.created_at >= vm.history_visible_from)`),
  );
  return row?.ok === true;
}

export interface ReactionCountRow {
  message_id: string;
  emoji: string;
  count: number;
  mine: boolean;
}

/** Ringkasan reaksi per pesan (urut reaksi pertama, lalu emoji); `mine` relatif terhadap `viewerId`. */
export async function reactionCounts(
  db: DbOrTx,
  messageIds: readonly string[],
  viewerId: string | null,
): Promise<Map<string, ReactionCountRow[]>> {
  const byMessage = new Map<string, ReactionCountRow[]>();
  if (messageIds.length === 0) return byMessage;
  const viewer = viewerId ? sql`${viewerId}::uuid` : sql`null::uuid`;
  const result = rows<ReactionCountRow>(
    await db.execute(sql`
      select r.message_id, r.emoji, count(*)::int as count, coalesce(bool_or(r.user_id = ${viewer}), false) as mine
      from app.message_reactions r
      where r.message_id in (${uuidList(messageIds)})
      group by r.message_id, r.emoji
      order by r.message_id, min(r.created_at), r.emoji`),
  );
  for (const row of result) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(row);
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

export interface InsertMessageInput {
  id: string;
  roomId: string;
  senderId: string | null;
  clientMessageId: string | null;
  kind: MessageKind;
  body: string | null;
  imageFileId?: string | null;
  replyToId?: string | null;
  /** Waktu Clock aplikasi; created_at tidak pernah lebih awal darinya (konsisten dengan history_visible_from). */
  now: Date;
}

/**
 * Insert pesan dengan aturan urutan commit C6 (AC F11-3): pemanggil WAJIB sudah memegang kunci baris room
 * ({@link lockRoom}) sebagai kunci pertama transaksi. created_at = greatest(clock_timestamp(), Clock aplikasi,
 * rooms.last_message_at + 1 mikrodetik) dan rooms.last_message_at = created_at dalam satu pernyataan, sehingga pesan
 * yang commit belakangan selalu berada sesudah semua pesan yang sudah commit di room itu.
 */
export async function insertMessageLocked(tx: Tx, input: InsertMessageInput): Promise<void> {
  const inserted = rows<{ id: string }>(
    await tx.execute(sql`
      with ins as (
        insert into app.messages (id, room_id, sender_id, client_message_id, kind, body, image_file_id,
                                  reply_to_id, created_at)
        select ${input.id}::uuid, r.id, ${input.senderId}::uuid, ${input.clientMessageId}::uuid,
               ${input.kind}::app.message_kind, ${input.body}::text, ${input.imageFileId ?? null}::uuid,
               ${input.replyToId ?? null}::uuid,
               greatest(clock_timestamp(), ${input.now.toISOString()}::timestamptz,
                        r.last_message_at + interval '1 microsecond')
        from app.rooms r where r.id = ${input.roomId}::uuid
        returning id, created_at
      )
      update app.rooms r set last_message_at = ins.created_at
      from ins where r.id = ${input.roomId}::uuid
      returning ins.id`),
  );
  if (inserted.length !== 1) throw new Error("Room pesan tidak ditemukan saat insert");
}
