#!/usr/bin/env node
// Uji beban API KAPDH: N-01 (p95 <= 500 ms baca sederhana, <= 1.000 ms keputusan/reservasi, 10 rps selama 15 menit,
// galat tak terduga < 1 %) dan N-04 (beban bertingkat untuk menemukan titik jenuh dan ambang naik kapasitas).
// PRD 2.4, 9.1 U-11; runbook docs/runbooks/load-test.md. Node >= 22, tanpa dependensi.
//
//   node infra/loadtest/api-load.mjs --credentials kapdh-loadtest.json --base-url https://api-staging.kapdh.or.id
//        [--rate 10 --duration 900 --warmup 60]                      # mode N-01 (bawaan)
//   node infra/loadtest/api-load.mjs ... --steps 10,20,40,60,80 --step-duration 300   # mode kapasitas N-04
//
// Sesi: --members akun anggota (bawaan 100, PRD 2.4 "100 sesi anggota") dan --admins admin ber-TOTP (bawaan 5).
// Campuran operasi (bobot dari 100 kedatangan): 79 baca anggota, 6 baca admin, 15 keputusan/reservasi (keputusan
// payment 5, reservasi event gratis 7, pembatalan tiket 3). Hanya kedatangan yang dihitung; keputusan payment juga
// membaca detail (dicatat sebagai baca admin) seperti layar pengurus.
//
// Hasil: <report-dir>/api-load-<waktu>.json dan .txt. Kode keluar mode N-01: 0 LULUS, 1 GAGAL ambang N-01, 2 TIDAK
// SAH (generator jenuh/dropped > 1 %, 429 > 1 %, sampel keputusan < 80 % rencana, atau setup gagal). Mode kapasitas:
// 0 bila selesai (laporan memuat titik jenuh), 2 bila tidak sah.
import {
  AdminSession,
  Api,
  asNumber,
  baseUrl,
  cliOptions,
  fmtMs,
  numArg,
  loadCredentials,
  mapLimit,
  MemberSession,
  pct,
  Recorder,
  runArrivals,
  uuid,
  writeReport,
} from "./lib.mjs";

const NAMES = [
  "credentials",
  "base-url",
  "rate",
  "duration",
  "warmup",
  "steps",
  "step-duration",
  "members",
  "admins",
  "max-in-flight",
  "report-dir",
  "read-p95-ms",
  "decision-p95-ms",
  "max-error-rate",
  "timeout-ms",
  "app-version",
  "seed",
];
const DEFAULTS = {
  rate: "10",
  duration: "900",
  warmup: "60",
  "step-duration": "300",
  members: "100",
  admins: "5",
  "max-in-flight": "400",
  "report-dir": "./loadtest-reports",
  "read-p95-ms": "500",
  "decision-p95-ms": "1000",
  "max-error-rate": "0.01",
  "timeout-ms": "30000",
  "app-version": "1.0.0",
  seed: "1",
};

const HELP = `Pakai: node infra/loadtest/api-load.mjs --credentials <berkas> --base-url <url> [opsi]
  --rate 10 --duration 900 --warmup 60          mode N-01 (laju/detik, detik)
  --steps 10,20,40,80 --step-duration 300       mode kapasitas N-04 (warmup memakai laju pertama)
  --members 100 --admins 5 --max-in-flight 400 --report-dir ./loadtest-reports
  --read-p95-ms 500 --decision-p95-ms 1000 --max-error-rate 0.01 --timeout-ms 30000
Opsi juga dapat diisi env KAPDH_LOAD_<NAMA> (mis. KAPDH_LOAD_BASE_URL).`;

// Batas server (PRD 2.5 rate limit) yang dihormati generator agar 429 tidak mengaburkan pengukuran.
const LIMITS = {
  search: { perMin: 50, perHour: 550 }, // server: 60/menit, 600/jam (directory.service.ts)
  profile: { perMin: 100, perHour: 1100 }, // server: 120/menit, 1200/jam
  reserve: { perMin: 1000, perHour: 18 }, // server: 20/jam (reservations.service.ts)
};
const NAME_PREFIXES = [
  "ahm",
  "muh",
  "abd",
  "fau",
  "has",
  "ril",
  "fa",
  "yus",
  "ari",
  "dim",
  "sit",
  "ais",
  "nur",
  "zah",
  "lai",
  "sal",
];
const CITIES = ["Bogor", "Jakarta", "Bandung", "Depok", "Bekasi", "Semarang", "Surabaya", "Medan"];

class Budget {
  constructor({ perMin, perHour }) {
    this.perMin = perMin;
    this.perHour = perHour;
    this.hits = [];
  }

  take(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < 3600_000);
    const lastMinute = this.hits.filter((t) => now - t < 60_000).length;
    if (this.hits.length >= this.perHour || lastMinute >= this.perMin) return false;
    this.hits.push(now);
    return true;
  }
}

/** PRNG deterministik agar dua run dengan --seed sama memilih urutan operasi yang sama. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const o = cliOptions(NAMES, DEFAULTS);
  if (o.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const creds = loadCredentials(o.credentials);
  const base = baseUrl(o["base-url"]);
  const steps = o.steps
    ? String(o.steps)
        .split(",")
        .map((s) => numArg(s, "steps", 0.1))
    : null;
  const rate = numArg(o.rate, "rate", 0.1);
  const durationS = numArg(o.duration, "duration", 1);
  const warmupS = numArg(o.warmup, "warmup", 0);
  const stepS = numArg(o["step-duration"], "step-duration", 1);
  const maxInFlight = numArg(o["max-in-flight"], "max-in-flight", 1);
  const readP95 = numArg(o["read-p95-ms"], "read-p95-ms", 1);
  const decisionP95 = numArg(o["decision-p95-ms"], "decision-p95-ms", 1);
  const maxErrorRate = numArg(o["max-error-rate"], "max-error-rate", 0);
  const random = rng(numArg(o.seed, "seed", 0));
  const pick = (items) => items[Math.floor(random() * items.length)];

  const recorder = new Recorder();
  const api = new Api(base, recorder, {
    timeoutMs: numArg(o["timeout-ms"], "timeout-ms", 100),
    appVersion: o["app-version"],
  });

  // ---------------------------------------------------------------------------------------------- setup
  const memberCreds = creds.members.slice(0, numArg(o.members, "members", 1));
  const adminCreds = creds.admins.slice(0, numArg(o.admins, "admins", 0));
  process.stdout.write(
    `Setup: login ${memberCreds.length} anggota dan ${adminCreds.length} admin ke ${base}\n`,
  );
  const members = await mapLimit(memberCreds, 5, async (m) => {
    const session = new MemberSession(api, m.email, creds.member_password, m.user_id);
    await session.login();
    return {
      session,
      rooms: [],
      tickets: new Map(),
      budgets: {
        search: new Budget(LIMITS.search),
        profile: new Budget(LIMITS.profile),
        reserve: new Budget(LIMITS.reserve),
      },
    };
  });
  const admins = await mapLimit(adminCreds, 2, async (a) => {
    const s = new AdminSession(api, a);
    await s.login();
    return s;
  });
  await mapLimit(members, 5, async (m) => {
    const res = await api.call("GET", "/chat/rooms?limit=50", {
      token: await m.session.token(),
      op: "setup.chat.rooms",
    });
    m.rooms = (res.json?.items ?? []).map((r) => ({ id: r.id, cursor: null }));
  });
  const eventsRes = await api.call("GET", "/events?limit=50", {
    token: await members[0].session.token(),
    op: "setup.events",
  });
  const eventIds = [
    ...new Set([...(creds.event_ids ?? []), ...(eventsRes.json?.items ?? []).map((e) => e.id)]),
  ];
  const freeEventIds = new Set(creds.event_ids ?? []);
  for (const e of eventsRes.json?.items ?? [])
    if (e.is_free && e.registration_state === "open") freeEventIds.add(e.id);
  const profileIds = creds.members.map((m) => m.user_id).filter(Boolean);
  const paymentQueue = [];
  const claimed = new Set();
  let refill = null;

  // --------------------------------------------------------------------------------------------- operasi
  const member = () => pick(members);
  const tokenOf = (m) => m.session.token();
  const get = async (op, path, m = member()) =>
    api.call("GET", path, { token: await tokenOf(m), op, cls: "read" });
  // Operasi yang tidak dapat dijalankan (anggaran rate limit habis, antrean payment kosong) diganti baca beranda dan
  // dicatat di `substituted` agar terlihat di laporan; keputusan yang banyak diganti membuat hasil tidak sah.
  const fallback = (op) => {
    recorder.substitute(op);
    return ops.home();
  };

  async function refillQueue(admin) {
    refill ??= (async () => {
      const res = await api.call("GET", "/admin/payments?stage=awaiting_review&limit=50", {
        token: await admin.token(),
        op: "admin.payments.queue",
        cls: "read",
      });
      for (const item of res.json?.items ?? [])
        if (!claimed.has(item.id) && !paymentQueue.includes(item.id)) paymentQueue.push(item.id);
    })().finally(() => {
      refill = null;
    });
    await refill;
  }

  const ops = {
    home: () => get("home", "/home"),
    posts: () => get("posts", "/posts?limit=20"),
    "events.list": () => get("events.list", "/events?limit=20"),
    "events.detail": () => get("events.detail", `/events/${pick(eventIds)}`),
    "directory.search": async () => {
      const m = member();
      if (!m.budgets.search.take()) return fallback("directory.search");
      const r = random();
      const query =
        r < 0.6
          ? `q=${pick(NAME_PREFIXES)}`
          : r < 0.8
            ? `cohort=${1 + Math.floor(random() * 30)}`
            : `city=${encodeURIComponent(pick(CITIES))}`;
      const res = await get("directory.search", `/directory?${query}&limit=20`, m);
      for (const item of res.json?.items ?? [])
        if (profileIds.length < 2000 && item.user_id) profileIds.push(item.user_id);
    },
    "directory.profile": async () => {
      const m = member();
      if (!m.budgets.profile.take()) return fallback("directory.profile");
      return get("directory.profile", `/directory/${pick(profileIds)}`, m);
    },
    me: () => get("me", "/me"),
    "me.card": () => get("me.card", "/me/card"),
    "me.membership": () => get("me.membership", "/me/membership"),
    notifications: () => get("notifications", "/notifications?limit=20"),
    "notifications.unread": () => get("notifications.unread", "/notifications/unread-count"),
    "chat.rooms": () => get("chat.rooms", "/chat/rooms?limit=20"),
    "chat.history": async () => {
      const m = pick(members.filter((x) => x.rooms.length > 0));
      if (!m) return fallback("chat.history");
      const room = pick(m.rooms);
      const older = room.cursor && random() < 0.5;
      const res = await get(
        "chat.history",
        `/chat/rooms/${room.id}/messages?limit=30${older ? `&before=${room.cursor}` : ""}`,
        m,
      );
      room.cursor = res.json?.next_cursor ?? null;
    },
    "public.config": () => api.call("GET", "/public/config", { op: "public.config", cls: "read" }),
    "tickets.list": () => get("tickets.list", "/me/tickets?limit=20"),
    "admin.payments.queue": async () => {
      if (admins.length === 0) return fallback("admin.payments.queue");
      return refillQueue(pick(admins));
    },
    "admin.members.search": async () => {
      if (admins.length === 0) return fallback("admin.members.search");
      const admin = pick(admins);
      return api.call("GET", `/admin/members?q=${pick(NAME_PREFIXES)}&limit=20`, {
        token: await admin.token(),
        op: "admin.members.search",
        cls: "read",
      });
    },
    "admin.dashboard": async () => {
      if (admins.length === 0) return fallback("admin.dashboard");
      const admin = pick(admins);
      return api.call("GET", "/admin/dashboard", {
        token: await admin.token(),
        op: "admin.dashboard",
        cls: "read",
      });
    },
    "payment.decide": async () => {
      if (admins.length === 0) return fallback("payment.decide");
      const admin = pick(admins);
      if (paymentQueue.length < 10) await refillQueue(admin);
      const id = paymentQueue.shift();
      if (!id) return fallback("payment.decide");
      claimed.add(id);
      const token = await admin.token();
      const detail = await api.call("GET", `/admin/payments/${id}`, {
        token,
        op: "admin.payments.detail",
        cls: "read",
      });
      if (detail.status !== 200 || detail.json?.stage !== "awaiting_review") return;
      await api.call("POST", `/admin/payments/${id}/decision`, {
        token,
        headers: { "idempotency-key": uuid() },
        body: {
          decision: "approve",
          expected_proof_version: detail.json.proof_version,
          expected_version: String(detail.json.version),
          funds_verified: true,
        },
        op: "payment.decide",
        cls: "decision",
        expect: [200],
        conflict: [409],
      });
    },
    "event.reserve": async () => {
      const free = [...freeEventIds];
      const candidates = members.filter((m) => m.tickets.size < free.length);
      const m = pick(candidates);
      const eventId = m ? pick(free.filter((id) => !m.tickets.has(id))) : undefined;
      if (!m || !eventId || !m.budgets.reserve.take()) return fallback("event.reserve");
      const res = await api.call("POST", `/events/${eventId}/reservations`, {
        token: await tokenOf(m),
        headers: { "idempotency-key": uuid() },
        body: { expected_price: "0.00", payment_method_id: null },
        op: "event.reserve",
        cls: "decision",
        expect: [201],
        conflict: [409],
      });
      if (res.status === 201 && res.json?.id)
        m.tickets.set(eventId, {
          id: res.json.id,
          version: res.json.version,
          refund: Boolean(res.json.refund_eligible),
        });
    },
    "ticket.cancel": async () => {
      const m = pick(members.filter((x) => x.tickets.size > 0));
      if (!m) return ops["event.reserve"]();
      const [eventId, ticket] = m.tickets.entries().next().value;
      m.tickets.delete(eventId);
      await api.call("POST", `/me/tickets/${ticket.id}/cancel`, {
        token: await tokenOf(m),
        headers: { "idempotency-key": uuid(), "if-match": String(ticket.version) },
        body: { expected_refund_eligible: ticket.refund, reason: null },
        op: "ticket.cancel",
        cls: "decision",
        expect: [200],
        conflict: [409],
      });
    },
  };

  const WEIGHTS = {
    home: 10,
    posts: 5,
    "events.list": 6,
    "events.detail": 5,
    "directory.search": 12,
    "directory.profile": 5,
    me: 5,
    "me.card": 3,
    "me.membership": 2,
    notifications: 4,
    "notifications.unread": 4,
    "chat.rooms": 6,
    "chat.history": 8,
    "public.config": 2,
    "tickets.list": 2,
    "admin.payments.queue": 3,
    "admin.members.search": 2,
    "admin.dashboard": 1,
    "payment.decide": 5,
    "event.reserve": 7,
    "ticket.cancel": 3,
  };
  const DECISION_OPS = ["payment.decide", "event.reserve", "ticket.cancel"];
  const decisionShare = DECISION_OPS.reduce((s, k) => s + WEIGHTS[k], 0) / 100;
  const table = Object.entries(WEIGHTS).flatMap(([name, w]) => Array(w).fill(name));
  const arrival = () => ops[pick(table)]();

  // ---------------------------------------------------------------------------------------------- jalan
  const phases = [];
  async function phase(name, phaseRate, seconds) {
    recorder.setPhase(name);
    process.stdout.write(`Fase ${name}: ${phaseRate} kedatangan/detik selama ${seconds} detik\n`);
    await runArrivals({
      rate: phaseRate,
      durationMs: seconds * 1000,
      maxInFlight,
      onArrival: arrival,
      recorder,
    });
    phases.push({ name, rate: phaseRate, seconds });
  }
  const firstRate = steps ? steps[0] : rate;
  if (warmupS > 0) await phase("warmup", firstRate, warmupS);
  if (steps) for (const r of steps) await phase(`step-${r}`, r, stepS);
  else await phase("measure", rate, durationS);

  // ---------------------------------------------------------------------------------------------- nilai
  const evaluate = (p) => {
    const rep = recorder.report(p.name);
    const read = rep.classes.read;
    const decision = rep.classes.decision;
    const plannedDecisions = p.rate * p.seconds * decisionShare;
    const checks = [
      {
        name: "read.p95",
        limit: `<= ${readP95} ms`,
        value: read?.p95 ?? null,
        pass: read ? asNumber(read.p95) <= readP95 : false,
      },
      {
        name: "decision.p95",
        limit: `<= ${decisionP95} ms`,
        value: decision?.p95 ?? null,
        pass: decision ? asNumber(decision.p95) <= decisionP95 : false,
      },
      {
        name: "unexpected_error_rate",
        limit: `< ${pct(maxErrorRate)}`,
        value: pct(rep.total.error_rate),
        pass: rep.total.error_rate < maxErrorRate,
      },
    ];
    const validity = [
      {
        name: "dropped_rate",
        limit: "<= 1 %",
        value: pct(rep.arrivals ? rep.dropped / rep.arrivals : 0),
        pass: rep.dropped <= rep.arrivals * 0.01,
      },
      {
        name: "rate_limited_rate",
        limit: "<= 1 %",
        value: pct(rep.total.rate_limited_rate),
        pass: rep.total.rate_limited_rate <= 0.01,
      },
      {
        name: "decision_samples",
        limit: `>= 80 % dari ${Math.round(plannedDecisions)}`,
        value: decision?.count ?? 0,
        pass: (decision?.count ?? 0) >= plannedDecisions * 0.8,
      },
    ];
    return {
      ...rep,
      rate: p.rate,
      checks,
      validity,
      pass: checks.every((c) => c.pass),
      valid: validity.every((c) => c.pass),
    };
  };
  const measured = phases.filter((p) => p.name !== "warmup").map(evaluate);
  const warmup = phases.some((p) => p.name === "warmup") ? recorder.report("warmup") : null;
  const setup = recorder.report("setup");

  let verdict;
  let exitCode;
  let capacity = null;
  if (steps) {
    const knee = measured.find((m) => !m.pass);
    const lastPass = [...measured].reverse().find((m) => m.pass && m.valid && (!knee || m.rate < knee.rate));
    capacity = {
      knee_rate: knee?.rate ?? null,
      capacity_rps: lastPass?.rate ?? null,
      scale_trigger_rps: lastPass ? Math.round(lastPass.rate * 0.7 * 10) / 10 : null,
      note: knee
        ? `Ambang N-01 pertama kali gagal pada ${knee.rate} kedatangan/detik.`
        : "Tidak ada tingkat yang gagal; naikkan --steps untuk menemukan titik jenuh.",
    };
    const valid = measured.every((m) => m.valid || (knee && m.rate >= knee.rate));
    verdict = valid ? "SELESAI" : "TIDAK SAH";
    exitCode = valid ? 0 : 2;
  } else {
    const m = measured[0];
    verdict = !m.valid ? "TIDAK SAH" : m.pass ? "LULUS" : "GAGAL";
    exitCode = !m.valid ? 2 : m.pass ? 0 : 1;
  }

  const report = {
    kind: "kapdh.loadtest_report",
    tool: "api-load",
    version: 1,
    prd: ["N-01", "N-04", "U-11"],
    base_url: base,
    dataset_id: creds.dataset_id,
    generated_at: new Date().toISOString(),
    config: {
      mode: steps ? "capacity" : "n01",
      rate,
      duration_s: durationS,
      warmup_s: warmupS,
      steps,
      step_duration_s: stepS,
      members: members.length,
      admins: admins.length,
      max_in_flight: maxInFlight,
      thresholds: { read_p95_ms: readP95, decision_p95_ms: decisionP95, max_error_rate: maxErrorRate },
      weights: WEIGHTS,
    },
    verdict,
    capacity,
    phases: measured,
    warmup,
    setup: setup ? { total: setup.total, ops: setup.ops } : null,
  };

  const lines = [
    `Uji beban API KAPDH (${steps ? "kapasitas N-04" : "N-01"}) — ${verdict}`,
    `Target: ${base}  dataset: ${creds.dataset_id}  sesi: ${members.length} anggota, ${admins.length} admin`,
    "",
  ];
  for (const m of measured) {
    lines.push(
      `Fase ${m.phase}: ${m.rate} kedatangan/detik, ${m.seconds} s, ${m.total.requests} permintaan (${m.achieved_rps} rps), dropped ${m.dropped}`,
    );
    for (const [cls, c] of Object.entries(m.classes))
      lines.push(
        `  ${cls.padEnd(9)} n=${String(c.count).padEnd(6)} p50=${fmtMs(c.p50)} p95=${fmtMs(c.p95)} p99=${fmtMs(c.p99)} galat=${c.error} konflik=${c.conflict} 429=${c.rate_limited}`,
      );
    for (const c of [...m.checks, ...m.validity])
      lines.push(
        `  ${c.pass ? "LULUS" : "GAGAL"} ${c.name.padEnd(22)} ${String(c.value).padEnd(12)} (${c.limit})`,
      );
    if (Object.keys(m.substituted).length)
      lines.push(`  diganti operasi lain: ${JSON.stringify(m.substituted)}`);
    lines.push("");
  }
  if (capacity)
    lines.push(
      `Kapasitas: ${capacity.capacity_rps ?? "-"} kedatangan/detik lulus N-01; titik gagal: ${capacity.knee_rate ?? "-"}; ambang naik kapasitas (70 %): ${capacity.scale_trigger_rps ?? "-"}`,
      capacity.note,
      "",
    );
  const text = `${lines.join("\n")}\n`;
  const files = writeReport(o["report-dir"], "api-load", report, text);
  process.stdout.write(text);
  process.stdout.write(`Laporan: ${files.json}\n`);
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`TIDAK SAH: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  },
);
