/**
 * API KAPDH NYATA untuk jalur uji klien web admin (`pnpm --filter @kapdh/admin test:live`, temuan audit D2-14).
 *
 * Proses ini dijalankan live/global-setup.ts (bukan bagian build web admin dan tidak pernah dibundel). Isinya sama
 * dengan aplikasi uji e2e API (apps/api/test/support/test-app.ts): aplikasi Nest/Fastify lengkap dari `apps/api/dist`
 * (`pnpm build` lebih dulu), database PGlite yang dimigrasi dengan migrator Drizzle production lalu diisi seed dev
 * (`@kapdh/database/seeds/dev`: alumni, metode bayar dan biaya contoh), MemoryMailer, storage memori, rate limit
 * memori, tanpa Redis. Bedanya, aplikasi MENDENGARKAN port TCP sungguhan sehingga web admin (React + klien
 * openapi-fetch yang dikirim ke pengguna) berbicara HTTP dengan API hasil merge, bukan dengan server tiruan
 * src/api/mocks.
 *
 * Fixture tambahan (di luar seed dev):
 * - dua admin aktif bersandi acak dan TOTP terverifikasi: Super Admin untuk UI, dan "Admin Keuangan"
 *   (payments.read + payments.decide) yang memutus lewat API sebagai admin lain (AC F04-3);
 * - bukti transfer alumni "[Contoh] Muhammad Rizki" untuk iuran pendaftarannya, dikirim lewat API anggota
 *   (POST /auth/login, POST /files, PUT /me/payments/{id}/proof), sehingga payment itu menunggu verifikasi.
 *
 * Kendali uji hanya di 127.0.0.1 pada port terpisah (tidak ada rute tambahan di API):
 * - GET  /clock                  → { now } waktu server;
 * - POST /clock/advance?ms=N     → majukan jam server (idle admin 30 menit, AC F02-5);
 * - POST /totp?admin=super|treasurer → { code } kode autentikator langkah waktu server saat ini. Server menolak
 *   langkah yang sudah dipakai (RFC 6238 §5.2), jadi bila langkah itu sudah diterbitkan jam dimajukan 30 detik;
 * - GET  /proof.png              → PNG valid untuk unggahan bukti dari UI.
 *
 * Saat siap, satu baris JSON `{"kapdhLive": {...}}` dicetak ke stdout. Sandi dan secret TOTP dibuat acak setiap
 * proses dan hanya berlaku untuk database memori proses ini; secret TOTP tidak pernah keluar dari proses.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "../../api");
const apiPackage = pathToFileURL(resolve(apiDir, "package.json")).href;

/** Paket server diresolusi dari apps/api (web admin tidak bergantung pada paket server, PRD 7.2). */
const fromApi = (specifier) => import(import.meta.resolve(specifier, apiPackage));
/** Modul API hasil build (`pnpm build`); dekorator Nest sudah dikompilasi di sana. */
const fromApiDist = (path) => import(pathToFileURL(resolve(apiDir, "dist", path)).href);

function fail(message, error) {
  process.stderr.write(`[kapdh-live] ${message}${error ? `: ${error.stack ?? error}` : ""}\n`);
  process.exit(1);
}

const port = Number(process.env.KAPDH_LIVE_PORT);
if (!Number.isInteger(port) || port <= 0) fail("KAPDH_LIVE_PORT wajib diisi port bebas");
const origin = `http://127.0.0.1:${port}`;
const secret = () => randomBytes(32).toString("base64url");

/** PNG 8x8 abu-abu yang valid (diproses sharp di server seperti foto bukti transfer). */
function png() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(0, 9);
  const rows = Buffer.alloc(size * (size + 1), 0x80);
  for (let y = 0; y < size; y += 1) rows[y * (size + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  await fromApi("reflect-metadata");
  const { PGlite } = await fromApi("@electric-sql/pglite");
  const { drizzle } = await fromApi("drizzle-orm/pglite");
  const { migrate } = await fromApi("drizzle-orm/pglite/migrator");
  const database = await fromApi("@kapdh/database");
  const { DEV_IDS, seedDev } = await fromApi("@kapdh/database/seeds/dev");
  const { loadApiEnv } = await fromApi("@kapdh/config");
  const { MemoryDriver } = await fromApi("@kapdh/storage");
  const bcrypt = (await fromApi("bcryptjs")).default;
  const { v7: uuidv7 } = await fromApi("uuid");
  const { createApp } = await fromApiDist("bootstrap.js");
  const { MemoryMailer } = await fromApiDist("core/adapters/mailer.js");
  const { DisabledPush } = await fromApiDist("core/adapters/push.js");
  const { commitAwareDb } = await fromApiDist("core/db/tx.js");
  const { MemoryRateLimitStore } = await fromApiDist("core/rate-limit/store.js");
  const { encryptSecret, newTotpSecret, totp } = await fromApiDist("core/identity/crypto.js");

  const env = loadApiEnv({
    NODE_ENV: "test",
    PORT: String(port),
    DATABASE_URL: "postgres://pglite.invalid/kapdh-live",
    LOG_LEVEL: "error",
    PUBLIC_WEB_URL: "http://web.test",
    API_PUBLIC_URL: origin,
    ADMIN_ORIGIN: origin,
    MAIL_FROM: "live@kapdh.test",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_ROOT: "/tmp",
    FILE_URL_SECRET: secret(),
    JWT_ACCESS_SECRET: secret(),
    JWT_ISSUER: origin,
    QR_SIGNING_KEYS: `k1:${secret()}`,
    OTP_HMAC_SECRET: secret(),
    TOTP_ENC_KEY: randomBytes(32).toString("hex"),
    BCRYPT_COST: "4",
    TRUST_PROXY_HOPS: "0",
    HSTS_ENABLED: "false",
  });

  // Jam server yang dapat dimajukan (idle 30 menit, langkah TOTP), seperti TestClock di e2e API.
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.now() + offsetMs) };

  const pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: database.MIGRATIONS_FOLDER });
  const raw = drizzle(pg, { schema: database.schema });
  await seedDev(raw, { now: clock.now() });

  async function createAdmin({ email, displayName, role, permissions }) {
    const now = clock.now();
    const userId = uuidv7();
    const adminId = uuidv7();
    const password = `Live#${randomBytes(12).toString("base64url")}`;
    const totpSecret = newTotpSecret();
    await raw.transaction(async (tx) => {
      await tx.insert(database.users).values({
        id: userId,
        email,
        passwordHash: await bcrypt.hash(password, env.BCRYPT_COST),
        status: "active",
        kind: "admin",
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(database.admins).values({
        id: adminId,
        userId,
        displayName,
        role,
        status: "active",
        activatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      if (permissions.length > 0)
        await tx
          .insert(database.adminPermissions)
          .values(permissions.map((permission) => ({ adminId, permission, createdAt: now })));
      await tx.insert(database.mfaTotp).values({
        userId,
        secretEncrypted: encryptSecret(totpSecret, env.TOTP_ENC_KEY),
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
    return { adminId, email, password, totpSecret, displayName, lastStep: -1 };
  }

  const superAdmin = await createAdmin({
    email: "super.live@kapdh.test",
    displayName: "Super Admin Live",
    role: "super_admin",
    permissions: [],
  });
  const treasurer = await createAdmin({
    email: "keuangan.live@kapdh.test",
    displayName: "Admin Keuangan",
    role: "admin",
    permissions: ["payments.read", "payments.decide"],
  });

  const app = await createApp(
    {
      env,
      db: commitAwareDb(raw),
      mailer: new MemoryMailer(),
      clock,
      push: new DisabledPush(),
      storage: new MemoryDriver(),
      redis: null,
    },
    { logger: false, rateLimitStore: new MemoryRateLimitStore() },
  );
  await app.listen({ port, host: "127.0.0.1" });

  // Alumni "[Contoh] Muhammad Rizki" mengirim bukti untuk iuran pendaftarannya lewat API anggota.
  const api = `${origin}/api/v1`;
  const mobile = { "X-App-Platform": "android", "X-App-Version": "1.0.0" };
  const call = async (path, init) => {
    const res = await fetch(`${api}${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method} ${path} -> ${res.status} ${text}`);
    return JSON.parse(text);
  };
  const login = await call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...mobile },
    body: JSON.stringify({ email: "contoh3@kapdh.test", password: "Kapdh#Dev2026", device_name: "live" }),
  });
  const member = { authorization: `Bearer ${login.session.access_token}`, ...mobile };
  const form = new FormData();
  form.append("purpose", "payment_proof");
  form.append("file", new Blob([png()], { type: "image/png" }), "bukti-transfer.png");
  const proof = await call("/files", { method: "POST", headers: member, body: form });
  await call(`/me/payments/${DEV_IDS.paymentPending}/proof`, {
    method: "PUT",
    headers: { ...member, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ file_id: proof.id, expected_proof_version: 0, transfer_note: "Transfer contoh" }),
  });

  const admins = { super: superAdmin, treasurer };
  const proofPng = png();
  const control = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/clock")
      return reply(200, { now: clock.now().toISOString() });
    if (req.method === "GET" && url.pathname === "/proof.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(proofPng);
    }
    if (req.method === "POST" && url.pathname === "/totp") {
      const admin = admins[url.searchParams.get("admin") ?? ""];
      if (!admin) return reply(404, { error: "admin tidak dikenal" });
      const stepOf = () => Math.floor(clock.now().getTime() / 30_000);
      // Server menyimpan langkah terakhir yang dipakai; kode baru wajib dari langkah sesudahnya.
      while (stepOf() <= admin.lastStep) offsetMs += 30_000;
      admin.lastStep = stepOf();
      return reply(200, { code: totp(admin.totpSecret, clock.now()) });
    }
    if (req.method === "POST" && url.pathname === "/clock/advance") {
      const ms = Number(url.searchParams.get("ms"));
      if (!Number.isFinite(ms) || ms < 0) return reply(400, { error: "ms wajib bilangan >= 0" });
      offsetMs += ms;
      return reply(200, { now: clock.now().toISOString() });
    }
    return reply(404, { error: "tidak ada" });
  });
  await new Promise((done) => control.listen(0, "127.0.0.1", done));
  const controlPort = control.address().port;

  const shutdown = async () => {
    control.close();
    await app.close().catch(() => undefined);
    await pg.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // Induk (globalSetup) mati tanpa teardown: jangan tinggalkan proses yatim.
  process.stdin.on("end", () => void shutdown());
  process.stdin.resume();

  process.stdout.write(
    `${JSON.stringify({
      kapdhLive: {
        origin,
        control: `http://127.0.0.1:${controlPort}`,
        admins: {
          super: { email: superAdmin.email, password: superAdmin.password, name: superAdmin.displayName },
          treasurer: { email: treasurer.email, password: treasurer.password, name: treasurer.displayName },
        },
        alumni: {
          unverified: { userId: DEV_IDS.alumniUnverified, name: "[Contoh] Ahmad Fauzi" },
          pending: {
            userId: DEV_IDS.alumniPending,
            name: "[Contoh] Muhammad Rizki",
            paymentId: DEV_IDS.paymentPending,
          },
        },
        paymentMethod: { id: DEV_IDS.paymentMethod, provider: "[Bank Contoh]" },
      },
    })}\n`,
  );
}

main().catch((error) => fail("API live gagal start", error));
