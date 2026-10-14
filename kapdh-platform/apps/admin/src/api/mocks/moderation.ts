import { mockAdminRef, mockHasPermission, requirePermission } from "./auth";
import { error, json, type MockRequest, type MockRoute, paginate, type S } from "./http";

/**
 * Tiruan antrean dan keputusan moderasi (kontrak admin-moderation C6, F-12, AC F12-2..F12-5, PRD 3.12):
 * - bawaan status=active (open + in_review) urut due; `counts` tidak terpengaruh filter;
 * - konflik kepentingan: laporan yang pihak terlapornya akun alumni tertaut pemanggil TIDAK PERNAH terlihat (dikecualikan
 *   dari item, total, counts, q; detail/klaim/putus = 404); pemanggil yang tertaut ke pelapor melihat laporan dengan
 *   `conflict_of_interest` true tetapi klaim/putus ditolak 403;
 * - klaim/putus memakai If-Match versi laporan (usang atau sudah diputus = 409 VERSION_CONFLICT dengan `current`);
 * - suspend/unsuspend wajib `confirm: true`; warn/suspend dan banding wajib `member_message`; banding hanya dismiss
 *   atau unsuspend; banding usang (`in_force` false) hanya unsuspend; unsuspend menghitung ulang status dari expires_at.
 * URL gambar bukti bertanda tangan 10 menit. Data contoh bukan bukti AC (PRD 7.3).
 */
type Detail = S["AdminModerationReportDetail"];
type Party = S["AdminModerationParty"];
type Target = S["AdminModerationTargetMember"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;

export const MOCK_REPORT_IDS = {
  threat: "0199e000-0000-7000-8000-00000000f001",
  harassment: "0199e000-0000-7000-8000-00000000f002",
  groupSpam: "0199e000-0000-7000-8000-00000000f003",
  appeal: "0199e000-0000-7000-8000-00000000f004",
  staleAppeal: "0199e000-0000-7000-8000-00000000f005",
  resolved: "0199e000-0000-7000-8000-00000000f006",
  ownReport: "0199e000-0000-7000-8000-00000000f007",
  /** Laporan terhadap akun alumni tertaut admin tiruan: tidak pernah terlihat (aturan butir a). */
  againstSelf: "0199e000-0000-7000-8000-00000000f008",
} as const;

const PEOPLE = {
  ridwan: {
    user_id: "0199e000-0000-7000-8000-0000000000c1",
    full_name: "ridwan",
    member_number: "06.02.01.4",
    cohort: 6,
  },
  arya: {
    user_id: "0199e000-0000-7000-8000-0000000000c2",
    full_name: "Arya Kamandanu",
    member_number: "10.02.01.3",
    cohort: 10,
  },
  bayu: {
    user_id: "0199e000-0000-7000-8000-0000000000c3",
    full_name: "Bayu Musthafa Arief",
    member_number: "09.02.01.5",
    cohort: 9,
  },
  sari: {
    user_id: "0199e000-0000-7000-8000-0000000000c5",
    full_name: "Sari Dewi",
    member_number: "11.01.02.8",
    cohort: 11,
  },
  dimas: {
    user_id: "0199e000-0000-7000-8000-0000000000c7",
    full_name: "Dimas Prasetyo",
    member_number: "12.02.01.9",
    cohort: 12,
  },
  lina: {
    user_id: "0199e000-0000-7000-8000-0000000000c8",
    full_name: "Lina Marlina",
    member_number: "08.01.02.3",
    cohort: 8,
  },
} satisfies Record<string, Party>;

/** Akun alumni tertaut admin tiruan yang sedang masuk (admins.linked_alumni_user_id). */
const CALLER_LINKED_USER = PEOPLE.bayu.user_id;

/** Grup "Info Bisnis Alumni" yang dilaporkan (laporan grup tanpa subjek). */
const GROUP_ROOM_ID = "0199e000-0000-7000-8000-00000000a010";

const NEVER_JOINED: Party = {
  user_id: "0199e000-0000-7000-8000-0000000000c9",
  full_name: "Hasan Basri",
  member_number: "13.02.01.1",
  cohort: 13,
};

interface RoomMembership {
  person: Party;
  status: S["ChatMemberStatus"];
  role: S["ChatMemberRole"];
  /** joined_at terisi: pernah bergabung. Undangan yang dibatalkan sebelum diterima tidak pernah bergabung. */
  everJoined: boolean;
}

/** Keanggotaan room tiruan (room_members) untuk calon subjek laporan grup. */
function roomFixtures(): Map<string, RoomMembership[]> {
  return new Map([
    [
      GROUP_ROOM_ID,
      [
        { person: PEOPLE.ridwan, status: "joined", role: "member", everJoined: true },
        { person: PEOPLE.dimas, status: "joined", role: "admin", everJoined: true },
        { person: PEOPLE.arya, status: "joined", role: "member", everJoined: true },
        { person: PEOPLE.sari, status: "left", role: "member", everJoined: true },
        { person: PEOPLE.lina, status: "removed", role: "admin", everJoined: true },
        // Akun tertaut admin pemanggil pernah bergabung lalu keluar: laporan tetap terlihat, tetapi ia bukan calon.
        { person: PEOPLE.bayu, status: "left", role: "member", everJoined: true },
        // Undangan dibatalkan sebelum diterima (joined_at kosong): tidak pernah bergabung, bukan calon subjek.
        { person: NEVER_JOINED, status: "removed", role: "member", everJoined: false },
      ],
    ],
  ]);
}

/** Status keanggotaan terkini alumni tiruan (dipakai calon subjek dan keputusan laporan grup). */
function memberFixtures(): Map<string, Target> {
  const states = new Map<string, Target>(Object.values(PEOPLE).map((p) => [p.user_id, target(p)]));
  states.set(
    PEOPLE.sari.user_id,
    target(PEOPLE.sari, {
      effective_status: "suspended",
      suspended_at: iso(-3 * 24 * HOUR),
      suspension_message: "Akun dibatasi karena spam berulang.",
    }),
  );
  return states;
}

export interface ModerationRequestLog {
  method: string;
  path: string;
  query: Record<string, string>;
  ifMatch: string | null;
  idempotencyKey: string | null;
  background: boolean;
  body: Record<string, unknown> | null;
}

/** Log permintaan moderasi (uji: If-Match, konfirmasi suspend, isi keputusan). */
export const moderationRequests: ModerationRequestLog[] = [];

let reports = new Map<string, Detail>();
let rooms = new Map<string, RoomMembership[]>();
let members = new Map<string, Target>();
/** Simulasi server lama yang belum mengimplementasikan adminListReportSubjectCandidates (404 rute tidak dikenal). */
let candidatesUnavailable = false;
const replays = new Map<string, { payload: string; body: unknown }>();

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function target(p: Party, extra: Partial<Target> = {}): Target {
  return {
    ...p,
    effective_status: "verified",
    expires_at: iso(200 * 24 * HOUR),
    suspended_at: null,
    suspension_message: null,
    ...extra,
  };
}

function image(fileId: string): S["AdminModerationEvidenceImage"] {
  return {
    file_id: fileId,
    url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#1A4B17"/></svg>')}`,
    url_expires_at: iso(10 * 60_000),
  };
}

function base(
  id: string,
  partial: Partial<Detail> & Pick<Detail, "category" | "priority" | "target_type" | "created_at" | "due_at">,
): Detail {
  return {
    id,
    status: "open",
    subject: null,
    room_name: null,
    overdue: false,
    claimed_by: null,
    claimed_at: null,
    action: null,
    resolved_at: null,
    description: null,
    reporter: PEOPLE.ridwan,
    target_member: null,
    room_id: null,
    evidence: {
      captured_at: partial.created_at,
      messages: [],
      room: null,
      profile: null,
      contested_suspension: null,
    },
    target_history: [],
    open_reports_against_target: 0,
    resolution: null,
    conflict_of_interest: false,
    version: "1",
    ...partial,
  };
}

function fixtures(): Map<string, Detail> {
  const roomId = "0199e000-0000-7000-8000-00000000a009";
  const list: Detail[] = [
    base(MOCK_REPORT_IDS.threat, {
      category: "violence_threat",
      priority: "urgent",
      target_type: "message",
      created_at: iso(-30 * HOUR),
      due_at: iso(-6 * HOUR),
      subject: PEOPLE.arya,
      room_name: "Alumni 2009",
      room_id: roomId,
      description: "Mengancam akan mendatangi rumah anggota lain.",
      target_member: target(PEOPLE.arya),
      open_reports_against_target: 1,
      evidence: {
        captured_at: iso(-30 * HOUR),
        messages: [
          {
            message_id: "0199e000-0000-7000-8000-00000000b001",
            reported: false,
            sender_user_id: PEOPLE.lina.user_id,
            sender_name: PEOPLE.lina.full_name,
            kind: "text",
            body: "Tolong jangan bahas politik di grup ini ya.",
            image: null,
            created_at: iso(-31 * HOUR),
            deleted_since_report: false,
          },
          {
            message_id: "0199e000-0000-7000-8000-00000000b002",
            reported: true,
            sender_user_id: PEOPLE.arya.user_id,
            sender_name: PEOPLE.arya.full_name,
            kind: "text",
            body: "Awas kamu, saya datangi rumahmu besok.",
            image: null,
            created_at: iso(-30.5 * HOUR),
            deleted_since_report: true,
          },
        ],
        room: { room_id: roomId, kind: "group", name: "Alumni 2009", avatar: null, member_count: 42 },
        profile: null,
        contested_suspension: null,
      },
    }),
    base(MOCK_REPORT_IDS.harassment, {
      category: "harassment",
      priority: "normal",
      target_type: "user",
      status: "in_review",
      created_at: iso(-10 * HOUR),
      due_at: iso(30 * HOUR),
      subject: PEOPLE.dimas,
      claimed_by: { admin_id: "0199e000-0000-7000-8000-0000000000b2", display_name: "Ahmad Zulhadi" },
      claimed_at: iso(-2 * HOUR),
      reporter: PEOPLE.lina,
      description: "Mengirim pesan menghina berulang kali.",
      target_member: target(PEOPLE.dimas, { effective_status: "expiring", expires_at: iso(10 * 24 * HOUR) }),
      target_history: [
        {
          kind: "warn",
          reason: "Komentar kasar di grup",
          actor_name: "Ahmad Zulhadi",
          created_at: iso(-40 * 24 * HOUR),
        },
      ],
      evidence: {
        captured_at: iso(-10 * HOUR),
        messages: [],
        room: null,
        profile: {
          full_name: PEOPLE.dimas.full_name,
          bio: "Pengusaha kuliner.",
          avatar: image("0199e000-0000-7000-8000-00000000d001"),
        },
        contested_suspension: null,
      },
      version: "2",
    }),
    base(MOCK_REPORT_IDS.groupSpam, {
      category: "spam",
      priority: "normal",
      target_type: "room",
      created_at: iso(-5 * HOUR),
      due_at: iso(43 * HOUR),
      room_name: "Info Bisnis Alumni",
      room_id: GROUP_ROOM_ID,
      description: "Grup dipakai untuk promosi investasi bodong.",
      evidence: {
        captured_at: iso(-5 * HOUR),
        // Kontrak createReport: bukti laporan grup hanya nama, avatar dan jumlah anggota, TANPA pesan.
        messages: [],
        room: {
          room_id: GROUP_ROOM_ID,
          kind: "group",
          name: "Info Bisnis Alumni",
          avatar: { file_id: "0199e000-0000-7000-8000-00000000d003", url: null, url_expires_at: null },
          member_count: 87,
        },
        profile: null,
        contested_suspension: null,
      },
    }),
    base(MOCK_REPORT_IDS.appeal, {
      category: "appeal",
      priority: "normal",
      target_type: "user",
      created_at: iso(-20 * HOUR),
      due_at: iso(28 * HOUR),
      subject: PEOPLE.sari,
      reporter: PEOPLE.sari,
      description: "Saya tidak mengirim spam; akun saya diretas dan sudah saya amankan.",
      target_member: target(PEOPLE.sari, {
        effective_status: "suspended",
        suspended_at: iso(-3 * 24 * HOUR),
        suspension_message: "Akun dibatasi karena spam berulang.",
      }),
      target_history: [
        {
          kind: "suspend",
          reason: "Spam berulang di 3 grup",
          actor_name: "Bayu Musthafa",
          created_at: iso(-3 * 24 * HOUR),
        },
      ],
      evidence: {
        captured_at: iso(-20 * HOUR),
        messages: [],
        room: null,
        profile: null,
        contested_suspension: {
          in_force: true,
          membership_event_id: "0199e000-0000-7000-8000-00000000e101",
          suspended_at: iso(-3 * 24 * HOUR),
          suspension_reason: "Spam berulang di 3 grup",
          suspension_message: "Akun dibatasi karena spam berulang.",
          suspended_by: { admin_id: "0199e000-0000-7000-8000-0000000000ad", display_name: "Bayu Musthafa" },
        },
      },
    }),
    base(MOCK_REPORT_IDS.staleAppeal, {
      category: "appeal",
      priority: "normal",
      target_type: "user",
      created_at: iso(-50 * HOUR),
      due_at: iso(-2 * HOUR),
      subject: PEOPLE.lina,
      reporter: PEOPLE.lina,
      description: "Mohon suspend saya ditinjau ulang.",
      target_member: target(PEOPLE.lina),
      evidence: {
        captured_at: iso(-50 * HOUR),
        messages: [],
        room: null,
        profile: null,
        contested_suspension: {
          in_force: false,
          membership_event_id: null,
          suspended_at: iso(-10 * 24 * HOUR),
          suspension_reason: "Konten tidak pantas",
          suspension_message: "Akun dibatasi sementara.",
          suspended_by: null,
        },
      },
    }),
    base(MOCK_REPORT_IDS.resolved, {
      category: "scam",
      priority: "normal",
      target_type: "user",
      status: "resolved",
      action: "warn",
      created_at: iso(-5 * 24 * HOUR),
      due_at: iso(-3 * 24 * HOUR),
      resolved_at: iso(-4 * 24 * HOUR),
      subject: PEOPLE.dimas,
      target_member: target(PEOPLE.dimas),
      resolution: {
        action: "warn",
        note: "Menawarkan arisan berantai.",
        member_message: "Jangan menawarkan skema investasi di aplikasi.",
        message_removed: false,
        resolved_at: iso(-4 * 24 * HOUR),
        resolved_by: { admin_id: "0199e000-0000-7000-8000-0000000000b2", display_name: "Ahmad Zulhadi" },
      },
      version: "3",
    }),
    base(MOCK_REPORT_IDS.ownReport, {
      category: "other",
      priority: "normal",
      target_type: "user",
      created_at: iso(-3 * HOUR),
      due_at: iso(45 * HOUR),
      subject: PEOPLE.ridwan,
      reporter: PEOPLE.bayu,
      description: "Akun ini memakai foto saya.",
      target_member: target(PEOPLE.ridwan),
      conflict_of_interest: true,
    }),
    base(MOCK_REPORT_IDS.againstSelf, {
      category: "harassment",
      priority: "urgent",
      target_type: "user",
      created_at: iso(-1 * HOUR),
      due_at: iso(23 * HOUR),
      subject: PEOPLE.bayu,
      target_member: target(PEOPLE.bayu),
    }),
  ];
  return new Map(list.map((r) => [r.id, r]));
}

export function reset(): void {
  reports = fixtures();
  rooms = roomFixtures();
  members = memberFixtures();
  candidatesUnavailable = false;
  replays.clear();
  moderationRequests.length = 0;
}
reset();

function log(req: MockRequest): void {
  moderationRequests.push({
    method: req.method,
    path: req.path,
    query: Object.fromEntries(req.url.searchParams.entries()),
    ifMatch: req.headers.get("If-Match"),
    idempotencyKey: req.headers.get("Idempotency-Key"),
    background: req.headers.get("X-Background-Request") === "1",
    body: req.body,
  });
}

/** Anggota room yang pernah bergabung (joined, atau left/removed dengan joined_at terisi). */
function everJoined(roomId: string | null): RoomMembership[] {
  return (roomId ? (rooms.get(roomId) ?? []) : []).filter(
    (m) => m.everJoined && (m.status === "joined" || m.status === "left" || m.status === "removed"),
  );
}

/**
 * Aturan konflik butir a: pemanggil tertaut ke pihak terlapor tidak pernah melihat laporan itu, termasuk laporan grup
 * tanpa subjek yang pemanggilnya anggota joined grup tersebut.
 */
function visibleToCaller(r: Detail): boolean {
  if (r.subject?.user_id === CALLER_LINKED_USER || r.target_member?.user_id === CALLER_LINKED_USER)
    return false;
  if (r.target_type === "room" && !r.subject)
    return !everJoined(r.room_id).some(
      (m) => m.person.user_id === CALLER_LINKED_USER && m.status === "joined",
    );
  return true;
}

const ROOM_STATUS_ORDER: Record<S["AdminModerationRoomMemberStatus"], number> = {
  joined: 0,
  left: 1,
  removed: 1,
};

/** Calon subjek laporan grup (kontrak adminListReportSubjectCandidates). */
function candidatesFor(r: Detail, q: string): S["AdminModerationSubjectCandidate"][] {
  return everJoined(r.room_id)
    .filter((m) => m.person.user_id !== CALLER_LINKED_USER)
    .filter(
      (m) =>
        !q || m.person.full_name.toLowerCase().includes(q) || (m.person.member_number ?? "").startsWith(q),
    )
    .map((m) => ({
      ...(members.get(m.person.user_id) ?? target(m.person)),
      room_status: m.status as S["AdminModerationRoomMemberStatus"],
      room_role: m.role,
    }))
    .sort((a, b) => {
      const rank = (c: typeof a) =>
        ROOM_STATUS_ORDER[c.room_status] * 2 +
        (c.room_status === "joined" && c.room_role === "admin" ? 0 : 1);
      return rank(a) - rank(b) || a.full_name.localeCompare(b.full_name, "id");
    });
}

function active(r: Detail): boolean {
  return r.status === "open" || r.status === "in_review";
}

/** `overdue` dihitung saat dibaca dari waktu server. */
function present(r: Detail): Detail {
  return { ...r, overdue: active(r) && Date.parse(r.due_at) <= Date.now() };
}

function item(r: Detail): S["AdminModerationReportItem"] {
  const p = present(r);
  return {
    id: p.id,
    category: p.category,
    priority: p.priority,
    status: p.status,
    target_type: p.target_type,
    subject: p.subject,
    room_name: p.room_name,
    created_at: p.created_at,
    due_at: p.due_at,
    overdue: p.overdue,
    claimed_by: p.claimed_by,
    claimed_at: p.claimed_at,
    action: p.action,
    resolved_at: p.resolved_at,
  };
}

/** Hitungan bersama untuk antrean, dasbor dan lencana (aturan butir c: visibilitas yang sama). */
export function moderationCounts(): S["AdminModerationQueueCounts"] & {
  oldest_open_created_at: string | null;
} {
  const visible = [...reports.values()].filter(visibleToCaller).map(present).filter(active);
  const oldest = visible.map((r) => r.created_at).sort()[0] ?? null;
  return {
    open: visible.filter((r) => r.status === "open").length,
    in_review: visible.filter((r) => r.status === "in_review").length,
    overdue: visible.filter((r) => r.overdue).length,
    urgent: visible.filter((r) => r.priority === "urgent").length,
    oldest_open_created_at: oldest,
  };
}

function find(req: MockRequest): { report: Detail } | { response: Response } {
  const id = req.params.reportId ?? "";
  if (!UUID.test(id))
    return {
      response: error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", {
        field_errors: { reportId: ["Id laporan tidak valid."] },
      }),
    };
  const r = reports.get(id);
  // Laporan terhadap akun tertaut pemanggil dijawab sama dengan yang tidak ada (aturan butir a).
  if (!r || !visibleToCaller(r)) return { response: error(404, "NOT_FOUND", "Laporan tidak ditemukan.") };
  return { report: r };
}

function idem(req: MockRequest): { response: Response | null; remember: (body: unknown) => void } {
  const key = req.headers.get("Idempotency-Key");
  const payload = JSON.stringify([req.path, req.body]);
  const prior = key ? replays.get(key) : undefined;
  if (prior)
    return {
      response:
        prior.payload === payload
          ? json(200, prior.body)
          : error(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key sudah dipakai untuk permintaan lain."),
      remember: () => undefined,
    };
  return { response: null, remember: (body) => key && replays.set(key, { payload, body }) };
}

function bump(r: Detail): Detail {
  return { ...r, version: String(Number(r.version) + 1) };
}

function bad(fe: Record<string, string[]>): Response {
  return error(400, "VALIDATION_ERROR", "Periksa kembali isian yang ditandai.", { field_errors: fe });
}

/** Kendali server tiruan untuk uji dan dev:mock. */
export const mockModeration = {
  get(id: string): Detail | undefined {
    const r = reports.get(id);
    return r ? present(r) : undefined;
  },
  /** Status keanggotaan terkini alumni tiruan. */
  member(userId: string): Target | undefined {
    return members.get(userId);
  },
  /** Server tanpa operasi calon subjek (belum diimplementasikan): rute menjawab 404 seperti rute tak dikenal. */
  setCandidatesUnavailable(value: boolean): void {
    candidatesUnavailable = value;
  },
  /** Pengurus lain memutus laporan ini lebih dulu (keputusan kalah balapan → 409). */
  resolveElsewhere(id: string): void {
    const r = reports.get(id);
    if (!r) return;
    const at = new Date().toISOString();
    const by = { admin_id: "0199e000-0000-7000-8000-0000000000b2", display_name: "Ahmad Zulhadi" };
    reports.set(
      id,
      bump({
        ...r,
        status: "dismissed",
        action: "dismiss",
        resolved_at: at,
        resolution: {
          action: "dismiss",
          note: "Bukan pelanggaran.",
          member_message: null,
          message_removed: false,
          resolved_at: at,
          resolved_by: by,
        },
      }),
    );
  },
};

export const routes: MockRoute[] = [
  {
    method: "GET",
    path: "/admin/reports",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "moderation.read");
      if (denied) return denied;
      const p = req.url.searchParams;
      const status = p.get("status") ?? "active";
      const priority = p.get("priority");
      const category = p.get("category");
      const targetType = p.get("target_type");
      const overdue = p.get("overdue");
      const q = (p.get("q") ?? "").trim().toLowerCase();
      const sort = p.get("sort") ?? "due";
      const items = [...reports.values()]
        .filter(visibleToCaller)
        .map(present)
        .filter((r) => (status === "active" ? active(r) : status === "all" ? true : r.status === status))
        .filter((r) => !priority || r.priority === priority)
        .filter((r) => !category || r.category === category)
        .filter((r) => !targetType || r.target_type === targetType)
        .filter((r) => overdue !== "true" || r.overdue)
        .filter(
          (r) =>
            !q ||
            (r.subject !== null &&
              (r.subject.full_name.toLowerCase().includes(q) ||
                (r.subject.member_number ?? "").startsWith(q))),
        )
        .sort((a, b) => {
          if (sort === "newest") return b.created_at.localeCompare(a.created_at);
          if (sort === "oldest") return a.created_at.localeCompare(b.created_at);
          return a.due_at.localeCompare(b.due_at) || a.created_at.localeCompare(b.created_at);
        })
        .map(item);
      const { oldest_open_created_at: _oldest, ...counts } = moderationCounts();
      void _oldest;
      return json(200, { ...paginate(items, req.url), counts } satisfies S["AdminModerationReportPage"]);
    },
  },
  {
    method: "GET",
    path: "/admin/reports/{reportId}",
    handler: (req) => {
      log(req);
      const denied = requirePermission(req, "moderation.read");
      if (denied) return denied;
      const found = find(req);
      if ("response" in found) return found.response;
      // Server menulis audit moderation.report_viewed sebelum respons; URL bukti diperbarui (<=10 menit).
      const r = present(found.report);
      const renew = (img: S["AdminModerationEvidenceImage"] | null) =>
        img && img.url ? { ...img, url_expires_at: iso(10 * 60_000) } : img;
      return json(200, {
        ...r,
        evidence: {
          ...r.evidence,
          messages: r.evidence.messages.map((m) => ({ ...m, image: renew(m.image) })),
          room: r.evidence.room ? { ...r.evidence.room, avatar: renew(r.evidence.room.avatar) } : null,
          profile: r.evidence.profile
            ? { ...r.evidence.profile, avatar: renew(r.evidence.profile.avatar) }
            : null,
        },
      });
    },
  },
  {
    method: "POST",
    path: "/admin/reports/{reportId}/claim",
    handler: (req) => {
      log(req);
      const denied =
        requirePermission(req, "moderation.read") ?? requirePermission(req, "moderation.resolve");
      if (denied) return denied;
      const replay = idem(req);
      if (replay.response) return replay.response;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.report;
      if (r.conflict_of_interest)
        return error(403, "FORBIDDEN", "Laporan yang Anda buat sendiri tidak dapat Anda tangani.");
      if (req.headers.get("If-Match") !== r.version || !active(r))
        return error(409, "VERSION_CONFLICT", "Laporan sudah berubah. Muat ulang.", { current: present(r) });
      const next = bump({
        ...r,
        status: "in_review",
        claimed_by: mockAdminRef(),
        claimed_at: new Date().toISOString(),
      });
      reports.set(r.id, next);
      const body = present(next);
      replay.remember(body);
      return json(200, body);
    },
  },
  {
    method: "POST",
    path: "/admin/reports/{reportId}/resolve",
    handler: (req) => {
      log(req);
      const denied =
        requirePermission(req, "moderation.read") ?? requirePermission(req, "moderation.resolve");
      if (denied) return denied;
      const replay = idem(req);
      if (replay.response) return replay.response;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.report;
      const b = req.body ?? {};
      const action = b.action as S["ModerationAction"];
      const fe: Record<string, string[]> = {};
      if (!["dismiss", "warn", "suspend", "unsuspend"].includes(action)) fe.action = ["Pilih tindakan."];
      const note = typeof b.note === "string" ? b.note.trim() : "";
      if (note.length < 3 || note.length > 1000) fe.note = ["Catatan 3-1000 karakter wajib diisi."];
      const memberMessage = typeof b.member_message === "string" ? b.member_message.trim() : "";
      const appeal = r.category === "appeal";
      if (
        (action === "warn" || action === "suspend" || appeal) &&
        (memberMessage.length < 3 || memberMessage.length > 500)
      )
        fe.member_message = ["Pesan untuk anggota 3-500 karakter wajib diisi."];
      if ((action === "suspend" || action === "unsuspend") && b.confirm !== true)
        fe.confirm = ["Konfirmasi eksplisit wajib untuk suspend/unsuspend."];
      if (b.remove_message === true && r.target_type !== "message")
        fe.remove_message = ["Hanya untuk laporan pesan."];
      if (appeal && action !== "dismiss" && action !== "unsuspend")
        fe.action = ["Banding hanya dapat ditolak (abaikan) atau dikabulkan (cabut suspend)."];
      const stale = appeal && r.evidence.contested_suspension?.in_force === false;
      if (stale && action === "dismiss")
        fe.action = ["Suspend yang dibanding sudah dicabut; tutup banding sebagai dikabulkan."];
      let subject: Target | null = r.target_member;
      const sid = b.subject_user_id;
      if (sid !== undefined && r.target_type !== "room")
        fe.subject_user_id = ["Subjek hanya dipilih untuk laporan grup."];
      if (r.target_type === "room" && !subject) {
        if (action === "dismiss" && sid !== undefined)
          fe.subject_user_id = ["Subjek hanya dipilih untuk warn, suspend, atau unsuspend."];
        if (action !== "dismiss") {
          // Kontrak adminResolveReport: subjek laporan grup = anggota/mantan anggota grup yang pernah bergabung.
          if (typeof sid !== "string" || !UUID.test(sid))
            fe.subject_user_id = ["Pilih anggota grup yang dikenai tindakan."];
          else if (sid === CALLER_LINKED_USER)
            return error(
              403,
              "FORBIDDEN",
              "Anda tidak dapat memutus perkara yang menyangkut akun Anda sendiri (konflik kepentingan).",
            );
          else if (!everJoined(r.room_id).some((m) => m.person.user_id === sid))
            fe.subject_user_id = ["Pilih anggota atau mantan anggota grup ini."];
          else subject = members.get(sid) ?? null;
        }
      }
      if (!stale && action === "suspend" && subject?.suspended_at)
        fe.action = ["Anggota sudah dalam status suspend."];
      if (!stale && action === "unsuspend" && subject && !subject.suspended_at)
        fe.action = ["Anggota tidak sedang di-suspend."];
      if (Object.keys(fe).length > 0) return bad(fe);
      if (r.conflict_of_interest)
        return error(403, "FORBIDDEN", "Laporan yang Anda buat sendiri tidak dapat Anda tangani.");
      if (req.headers.get("If-Match") !== r.version || !active(r))
        return error(409, "VERSION_CONFLICT", "Laporan sudah diputus atau diubah pengurus lain.", {
          current: present(r),
        });

      const at = new Date().toISOString();
      const by = mockAdminRef();
      let member = subject;
      if (member && !stale) {
        if (action === "suspend")
          member = {
            ...member,
            effective_status: "suspended",
            suspended_at: at,
            suspension_message: memberMessage,
          };
        if (action === "unsuspend") {
          // AC F12-5: status dihitung ulang dari expires_at, bukan otomatis verified.
          const expired = member.expires_at !== null && Date.parse(member.expires_at) <= Date.now();
          member = {
            ...member,
            effective_status: expired ? "expired" : "verified",
            suspended_at: null,
            suspension_message: null,
          };
        }
      }
      const history =
        member && !stale && action !== "dismiss"
          ? [
              { kind: action, reason: note, actor_name: by.display_name, created_at: at },
              ...r.target_history,
            ].slice(0, 20)
          : r.target_history;
      const next = bump({
        ...r,
        status: action === "dismiss" ? "dismissed" : "resolved",
        action,
        resolved_at: at,
        subject: member
          ? {
              user_id: member.user_id,
              full_name: member.full_name,
              member_number: member.member_number,
              cohort: member.cohort,
            }
          : r.subject,
        target_member: member,
        target_history: history as Detail["target_history"],
        evidence:
          appeal && r.evidence.contested_suspension && action === "unsuspend"
            ? { ...r.evidence, contested_suspension: { ...r.evidence.contested_suspension, in_force: false } }
            : r.evidence,
        resolution: {
          action,
          note,
          member_message: memberMessage || null,
          message_removed: b.remove_message === true,
          resolved_at: at,
          resolved_by: by,
        },
      });
      reports.set(r.id, next);
      if (member && !stale) members.set(member.user_id, member);
      const body = present(next);
      replay.remember(body);
      return json(200, body);
    },
  },
  {
    method: "GET",
    path: "/admin/reports/{reportId}/subject-candidates",
    handler: (req) => {
      log(req);
      if (candidatesUnavailable) return error(404, "NOT_FOUND", "Data tidak ditemukan.");
      const denied =
        requirePermission(req, "moderation.read") ?? requirePermission(req, "moderation.resolve");
      if (denied) return denied;
      const found = find(req);
      if ("response" in found) return found.response;
      const r = found.report;
      if (r.conflict_of_interest)
        return error(403, "FORBIDDEN", "Laporan yang Anda buat sendiri tidak dapat Anda tangani.");
      if (r.target_type !== "room" || !active(r))
        return bad({ reportId: ["Calon subjek hanya untuk laporan grup yang masih aktif."] });
      const q = (req.url.searchParams.get("q") ?? "").trim().toLowerCase();
      // Server menulis audit moderation.report_viewed (tanpa daftar anggota) sebelum respons.
      const { items, next_cursor } = paginate(candidatesFor(r, q), req.url);
      return json(200, { items, next_cursor } satisfies S["AdminModerationSubjectCandidatePage"]);
    },
  },
];

/** Untuk tiruan dasbor: apakah admin tiruan berizin moderasi. */
export function canReadModeration(): boolean {
  return mockHasPermission("moderation.read");
}
