#!/usr/bin/env node
// Uji beban realtime KAPDH N-02: p95 waktu dari pengiriman pesan (POST, ack sesudah commit) sampai event
// `message.created` diterima socket penerima ONLINE <= 2 detik, dan reconnect mengambil pesan yang terlewat tanpa
// celah atau duplikasi (sinkron `after=<jangkar>`, AC F11-3). PRD 2.4, 9.1 U-07/U-11; docs/runbooks/load-test.md.
// Node >= 22, tanpa dependensi. Jalankan BERSAMAAN dengan api-load.mjs (mode N-01) agar terukur di bawah beban PRD 2.4.
//
//   node infra/loadtest/realtime-load.mjs --credentials kapdh-loadtest.json --base-url https://api-staging.kapdh.or.id
//        [--sessions 100 --rate 2 --duration 600 --warmup 30 --reconnect-fraction 0.1]
//
// Latensi diukur dengan jam generator yang sama: t0 = sebelum POST dikirim (batas atas waktu commit), t1 = event
// diterima penerima. Pesan yang tidak diterima penerima online dalam --grace-ms dihitung tak hingga (konservatif).
// Kode keluar: 0 LULUS, 1 GAGAL (p95 > ambang, pengiriman hilang, atau sinkron reconnect tidak lengkap/duplikat),
// 2 TIDAK SAH (setup gagal, sampel terlalu sedikit, atau pengiriman ditolak 429/galat > 1 %).
import {
  Api,
  asNumber,
  baseUrl,
  cliOptions,
  fmtMs,
  loadCredentials,
  mapLimit,
  MemberSession,
  nowMs,
  numArg,
  pct,
  RealtimeClient,
  Recorder,
  runArrivals,
  sleep,
  summarize,
  uuid,
  writeReport,
} from "./lib.mjs";

const NAMES = [
  "credentials",
  "base-url",
  "sessions",
  "rate",
  "duration",
  "warmup",
  "threshold-ms",
  "grace-ms",
  "reconnect-fraction",
  "reconnect-gap",
  "max-in-flight",
  "report-dir",
  "timeout-ms",
  "app-version",
];
const DEFAULTS = {
  sessions: "100",
  rate: "2",
  duration: "600",
  warmup: "30",
  "threshold-ms": "2000",
  "grace-ms": "10000",
  "reconnect-fraction": "0.1",
  "reconnect-gap": "15",
  "max-in-flight": "200",
  "report-dir": "./loadtest-reports",
  "timeout-ms": "30000",
  "app-version": "1.0.0",
};
const HELP = `Pakai: node infra/loadtest/realtime-load.mjs --credentials <berkas> --base-url <url> [opsi]
  --sessions 100 --rate 2 (pesan/detik total) --duration 600 --warmup 30
  --threshold-ms 2000 --grace-ms 10000 --reconnect-fraction 0.1 --reconnect-gap 15 --report-dir ./loadtest-reports`;
// Server: 60 pesan/menit per pengirim (chat.constants.ts); generator memakai 50.
const SEND_PER_MIN = 50;

async function main() {
  const o = cliOptions(NAMES, DEFAULTS);
  if (o.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const creds = loadCredentials(o.credentials);
  const base = baseUrl(o["base-url"]);
  const rate = numArg(o.rate, "rate", 0.01);
  const durationS = numArg(o.duration, "duration", 1);
  const warmupS = numArg(o.warmup, "warmup", 0);
  const thresholdMs = numArg(o["threshold-ms"], "threshold-ms", 1);
  const graceMs = numArg(o["grace-ms"], "grace-ms", 100);
  const reconnectFraction = numArg(o["reconnect-fraction"], "reconnect-fraction", 0);
  const reconnectGapS = numArg(o["reconnect-gap"], "reconnect-gap", 0);
  const maxInFlight = numArg(o["max-in-flight"], "max-in-flight", 1);
  const recorder = new Recorder();
  const api = new Api(base, recorder, {
    timeoutMs: numArg(o["timeout-ms"], "timeout-ms", 100),
    appVersion: o["app-version"],
  });
  const pick = (items) => items[Math.floor(Math.random() * items.length)];

  // ---------------------------------------------------------------------------------------------- setup
  const memberCreds = creds.members.slice(0, numArg(o.sessions, "sessions", 2));
  process.stdout.write(`Setup: login dan sambung realtime ${memberCreds.length} sesi anggota ke ${base}\n`);
  const sessions = await mapLimit(memberCreds, 5, async (m, index) => {
    const session = new MemberSession(api, m.email, creds.member_password, m.user_id);
    await session.login();
    return { index, session, client: new RealtimeClient(base), sends: [], unexpectedCloses: 0 };
  });
  const pending = new Map(); // client_message_id -> entri
  const counters = { duplicates: 0, lostOnDisconnect: 0, unexpectedDisconnects: 0, foreignEvents: 0 };
  let measuring = false;

  function onMessage(s, envelope, at) {
    const msg = envelope?.payload?.message;
    const entry = msg ? pending.get(msg.client_message_id) : undefined;
    if (!entry) {
      counters.foreignEvents += 1;
      return;
    }
    if (s.index === entry.sender) return;
    if (entry.received.has(s.index)) {
      counters.duplicates += 1;
      return;
    }
    entry.received.set(s.index, at - entry.t0);
  }

  /** Socket `s` tidak lagi online: pesan yang masih ditunggunya tidak dihitung sebagai latensi (dicatat terpisah). */
  function forgetPending(s) {
    let n = 0;
    for (const entry of pending.values())
      if (entry.expected.has(s.index) && !entry.received.has(s.index)) {
        entry.expected.delete(s.index);
        n += 1;
      }
    return n;
  }

  async function connect(s) {
    s.client = new RealtimeClient(base);
    s.client.on("message.created", (env, at) => onMessage(s, env, at));
    s.client.onClose = () => {
      counters.unexpectedDisconnects += 1;
      s.unexpectedCloses += 1;
      counters.lostOnDisconnect += forgetPending(s);
    };
    await s.client.connect(await s.session.token());
  }
  await mapLimit(sessions, 10, connect);

  // Room yang diikuti >= 2 sesi online (room realtime dataset diutamakan).
  const roomSessions = new Map();
  await mapLimit(sessions, 5, async (s) => {
    const res = await api.call("GET", "/chat/rooms?limit=50", {
      token: await s.session.token(),
      op: "setup.chat.rooms",
    });
    for (const room of res.json?.items ?? []) {
      if (room.kind !== "group" || room.can_send === false) continue;
      if (!roomSessions.has(room.id)) roomSessions.set(room.id, new Set());
      roomSessions.get(room.id).add(s.index);
    }
  });
  const preferred = new Set(creds.realtime_room_ids ?? []);
  let rooms = [...roomSessions.entries()].filter(([, set]) => set.size >= 2);
  if (rooms.some(([id]) => preferred.has(id))) rooms = rooms.filter(([id]) => preferred.has(id));
  if (rooms.length === 0)
    throw new Error("tidak ada room grup dengan >= 2 sesi; periksa dataset loadtest:seed");
  process.stdout.write(
    `Room realtime: ${rooms.length}; sesi online: ${sessions.filter((s) => s.client.connected).length}\n`,
  );

  // ---------------------------------------------------------------------------------------------- kirim
  const canSend = (s) => {
    const now = Date.now();
    s.sends = s.sends.filter((t) => now - t < 60_000);
    return s.client.connected && s.sends.length < SEND_PER_MIN;
  };
  let seq = 0;
  async function send() {
    const [roomId, members] = pick(rooms);
    const candidates = [...members].map((i) => sessions[i]).filter(canSend);
    const sender = pick(candidates);
    if (!sender) {
      recorder.substitute("chat.send");
      return;
    }
    sender.sends.push(Date.now());
    const clientMessageId = uuid();
    const expected = new Set([...members].filter((i) => i !== sender.index && sessions[i].client.connected));
    const entry = {
      roomId,
      sender: sender.index,
      expected,
      received: new Map(),
      t0: 0,
      measured: measuring,
      acked: null,
    };
    const token = await sender.session.token();
    entry.t0 = nowMs();
    pending.set(clientMessageId, entry);
    const res = await api.call("POST", `/chat/rooms/${roomId}/messages`, {
      token,
      body: { client_message_id: clientMessageId, kind: "text", body: `[Uji Beban] realtime ${++seq}` },
      op: "chat.send",
      cls: "chat",
      expect: [200, 201],
    });
    if (res.outcome !== "ok") pending.delete(clientMessageId);
    else entry.acked = { at: Date.now(), id: res.json?.id };
  }

  // ---------------------------------------------------------------------------------------- reconnect
  const reconnect = { sessions: 0, rooms_synced: 0, expected: 0, missing: 0, duplicates: 0, errors: 0 };
  async function reconnectCheck() {
    const chosen = [...sessions]
      .filter((s) => s.client.connected)
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.floor(sessions.length * reconnectFraction));
    if (chosen.length === 0) return;
    reconnect.sessions = chosen.length;
    const plans = await Promise.all(
      chosen.map(async (s) => {
        const token = await s.session.token();
        const anchors = new Map();
        for (const [roomId, members] of rooms) {
          if (!members.has(s.index)) continue;
          // Jangkar sinkron HANYA dari respons HTTP (events/README.md, AC F11-3).
          const res = await api.call("GET", `/chat/rooms/${roomId}/messages?limit=1`, {
            token,
            op: "sync.anchor",
            cls: "sync",
          });
          const last = res.json?.items?.at(-1);
          if (last) anchors.set(roomId, last.id);
        }
        // Putus sengaja (uji reconnect): pesan yang belum tiba ke socket ini diharapkan dari sinkron, bukan event.
        s.client.onClose = null;
        s.client.close();
        const offlineAt = Date.now();
        forgetPending(s);
        return { s, anchors, offlineAt };
      }),
    );
    await sleep(reconnectGapS * 1000);
    await Promise.all(
      plans.map(async ({ s, anchors, offlineAt }) => {
        try {
          await connect(s);
        } catch {
          reconnect.errors += 1;
          return;
        }
        const syncStartedAt = Date.now();
        const token = await s.session.token();
        for (const [roomId, anchor] of anchors) {
          const seen = new Map();
          let after = anchor;
          for (let page = 0; page < 100 && after; page++) {
            const res = await api.call("GET", `/chat/rooms/${roomId}/messages?after=${after}&limit=50`, {
              token,
              op: "sync.after",
              cls: "sync",
            });
            if (res.status !== 200) {
              reconnect.errors += 1;
              break;
            }
            for (const item of res.json.items ?? []) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
            after = res.json.next_cursor ?? null;
          }
          reconnect.rooms_synced += 1;
          for (const count of seen.values()) if (count > 1) reconnect.duplicates += 1;
          // Setiap pesan alat ini yang di-ack selama offline (sebelum sinkron mulai) wajib ada tepat sekali.
          for (const entry of pending.values()) {
            if (entry.roomId !== roomId || !entry.acked?.id) continue;
            if (entry.acked.at < offlineAt || entry.acked.at > syncStartedAt) continue;
            reconnect.expected += 1;
            if (!seen.has(entry.acked.id)) reconnect.missing += 1;
          }
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------- jalan
  if (warmupS > 0) {
    recorder.setPhase("warmup");
    process.stdout.write(`Fase warmup: ${rate} pesan/detik selama ${warmupS} detik\n`);
    await runArrivals({ rate, durationMs: warmupS * 1000, maxInFlight, onArrival: send, recorder });
  }
  recorder.setPhase("measure");
  measuring = true;
  process.stdout.write(`Fase measure: ${rate} pesan/detik selama ${durationS} detik\n`);
  const reconnectTask =
    reconnectFraction > 0 ? sleep((durationS * 1000) / 3).then(reconnectCheck) : Promise.resolve();
  await runArrivals({ rate, durationMs: durationS * 1000, maxInFlight, onArrival: send, recorder });
  await reconnectTask;
  await sleep(graceMs);
  measuring = false;
  for (const s of sessions) {
    s.client.onClose = null;
    s.client.close();
  }

  // ---------------------------------------------------------------------------------------------- nilai
  const latencies = [];
  let expectedDeliveries = 0;
  let missing = 0;
  let measuredMessages = 0;
  for (const entry of pending.values()) {
    if (!entry.measured || !entry.acked) continue;
    measuredMessages += 1;
    for (const i of entry.expected) {
      expectedDeliveries += 1;
      const ms = entry.received.get(i);
      if (ms === undefined) {
        missing += 1;
        latencies.push(Infinity);
      } else latencies.push(ms);
    }
  }
  const delivery = summarize(latencies);
  const sendPhase = recorder.report("measure");
  const sendStats = sendPhase?.ops["chat.send"] ?? null;
  const sendTotal = sendStats ? sendStats.count : 0;
  const sendBad = sendStats ? sendStats.error + sendStats.rate_limited : 0;
  const plannedMessages = rate * durationS;
  const checks = [
    {
      name: "delivery.p95",
      limit: `<= ${thresholdMs} ms`,
      value: delivery.p95,
      pass: delivery.count > 0 && asNumber(delivery.p95) <= thresholdMs,
    },
    { name: "delivery.missing", limit: "= 0", value: missing, pass: missing === 0 },
    {
      name: "delivery.duplicates",
      limit: "= 0",
      value: counters.duplicates,
      pass: counters.duplicates === 0,
    },
    {
      name: "reconnect.sync",
      limit: "0 hilang, 0 duplikat",
      value: `${reconnect.missing} hilang, ${reconnect.duplicates} duplikat, ${reconnect.errors} galat`,
      pass: reconnect.missing === 0 && reconnect.duplicates === 0 && reconnect.errors === 0,
    },
  ];
  const validity = [
    {
      name: "messages",
      limit: `>= 80 % dari ${Math.round(plannedMessages)}`,
      value: measuredMessages,
      pass: measuredMessages >= plannedMessages * 0.8,
    },
    {
      name: "send_errors",
      limit: "<= 1 %",
      value: pct(sendTotal ? sendBad / sendTotal : 0),
      pass: sendBad <= sendTotal * 0.01,
    },
    {
      name: "dropped",
      limit: "<= 1 %",
      value: sendPhase?.dropped ?? 0,
      pass: (sendPhase?.dropped ?? 0) <= (sendPhase?.arrivals ?? 0) * 0.01,
    },
  ];
  const valid = validity.every((c) => c.pass);
  const pass = checks.every((c) => c.pass);
  const verdict = !valid ? "TIDAK SAH" : pass ? "LULUS" : "GAGAL";

  const report = {
    kind: "kapdh.loadtest_report",
    tool: "realtime-load",
    version: 1,
    prd: ["N-02", "U-07", "U-11"],
    base_url: base,
    dataset_id: creds.dataset_id,
    generated_at: new Date().toISOString(),
    config: {
      sessions: sessions.length,
      rooms: rooms.length,
      rate,
      duration_s: durationS,
      warmup_s: warmupS,
      threshold_ms: thresholdMs,
      grace_ms: graceMs,
      reconnect_fraction: reconnectFraction,
      reconnect_gap_s: reconnectGapS,
    },
    verdict,
    delivery: {
      messages: measuredMessages,
      expected: expectedDeliveries,
      missing,
      duplicates: counters.duplicates,
      latency_ms: delivery,
    },
    send: sendStats,
    counters,
    reconnect,
    checks,
    validity,
  };
  const lines = [
    `Uji beban realtime KAPDH (N-02) — ${verdict}`,
    `Target: ${base}  sesi: ${sessions.length}  room: ${rooms.length}  laju: ${rate} pesan/detik selama ${durationS} s`,
    `Pengiriman ke penerima online: ${expectedDeliveries} (dari ${measuredMessages} pesan), hilang ${missing}, duplikat ${counters.duplicates}`,
    `Latensi kirim->terima: p50=${fmtMs(delivery.p50)} p95=${fmtMs(delivery.p95)} p99=${fmtMs(delivery.p99)} maks=${fmtMs(delivery.max)}`,
    `Ack POST pesan: p95=${fmtMs(sendStats?.p95)} galat=${sendStats?.error ?? 0} 429=${sendStats?.rate_limited ?? 0}`,
    `Reconnect: ${reconnect.sessions} sesi, ${reconnect.rooms_synced} room disinkron, ${reconnect.expected} pesan wajib ada`,
    `Putus tak terduga: ${counters.unexpectedDisconnects} (pengiriman tertunda ${counters.lostOnDisconnect})`,
    "",
    ...[...checks, ...validity].map(
      (c) => `${c.pass ? "LULUS" : "GAGAL"} ${c.name.padEnd(20)} ${String(c.value).padEnd(14)} (${c.limit})`,
    ),
    "",
  ];
  const text = `${lines.join("\n")}\n`;
  const files = writeReport(o["report-dir"], "realtime-load", report, text);
  process.stdout.write(text);
  process.stdout.write(`Laporan: ${files.json}\n`);
  return !valid ? 2 : pass ? 0 : 1;
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
