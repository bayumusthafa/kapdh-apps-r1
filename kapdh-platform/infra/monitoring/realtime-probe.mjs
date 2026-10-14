// Probe realtime KAPDH (PRD 5.5 "monitoring wajib meliputi ... koneksi WS", N-05; docs/runbooks/monitoring.md).
// Membuka WebSocket Socket.IO (EIO 4, transport websocket saja, seperti gateway ARCHITECTURE §4.9) ke namespace
// /realtime, lalu:
//   * tanpa REALTIME_PROBE_TOKEN: mengirim token tidak sah dan mengharapkan CONNECT_ERROR dari middleware gateway
//     (membuktikan Traefik -> API -> Socket.IO -> autentikasi hidup tanpa akun);
//   * dengan REALTIME_PROBE_TOKEN (access token akun uji): mengharapkan CONNECT sukses.
// Node >= 22 (WebSocket bawaan), tanpa dependensi. Keluaran satu baris `PASS|FAIL realtime <detail>`; keluar 1 bila
// gagal. Bila KUMA_PUSH_REALTIME diisi, hasil juga dikirim ke monitor Push Uptime Kuma. Token tidak pernah dicetak.
//
//   REALTIME_URL=https://api.kapdh.or.id node infra/monitoring/realtime-probe.mjs
const TIMEOUT_MS = Number(process.env.REALTIME_PROBE_TIMEOUT_MS ?? 10_000);
const NAMESPACE = "/realtime";

function wsUrl(base) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/socket.io/";
  url.search = "?EIO=4&transport=websocket";
  return url.toString();
}

async function push(status, msg, ping) {
  const target = process.env.KUMA_PUSH_REALTIME;
  if (!target) return;
  const url = new URL(target);
  url.searchParams.set("status", status);
  url.searchParams.set("msg", msg);
  url.searchParams.set("ping", String(ping ?? ""));
  await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}

function probe(base, token) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // abaikan
      }
      resolve({ ok, detail, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, `tidak ada jawaban dalam ${TIMEOUT_MS} ms`), TIMEOUT_MS);
    try {
      socket = new WebSocket(wsUrl(base));
    } catch (error) {
      finish(false, `URL tidak valid (${error?.name ?? "galat"})`);
      return;
    }
    socket.addEventListener("error", () => finish(false, "koneksi WebSocket gagal"));
    socket.addEventListener("close", (event) => finish(false, `koneksi ditutup (kode ${event.code})`));
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data.startsWith("0{")) {
        // OPEN engine.io -> CONNECT Socket.IO ke namespace dengan auth handshake.
        socket.send(`40${NAMESPACE},${JSON.stringify({ token: token || "probe-token-tidak-sah" })}`);
        return;
      }
      if (data === "2") {
        socket.send("3");
        return;
      }
      if (data.startsWith(`40${NAMESPACE},`)) {
        finish(
          Boolean(token),
          token ? "terhubung ke /realtime" : "token tidak sah DITERIMA (autentikasi gateway?)",
        );
        return;
      }
      if (data.startsWith(`44${NAMESPACE},`)) {
        finish(
          !token,
          token ? "token akun uji ditolak gateway" : "gateway menolak token tidak sah (CONNECT_ERROR)",
        );
      }
    });
  });
}

const base = process.env.REALTIME_URL ?? "";
if (!/^(https?|wss?):\/\//.test(base)) {
  process.stdout.write("FAIL realtime REALTIME_URL wajib, mis. https://api.kapdh.or.id\n");
  process.exitCode = 1;
} else {
  const result = await probe(base, process.env.REALTIME_PROBE_TOKEN ?? "");
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"} realtime ${result.detail} (${result.ms} ms)\n`);
  await push(result.ok ? "up" : "down", result.detail, result.ms);
  process.exitCode = result.ok ? 0 : 1;
}
