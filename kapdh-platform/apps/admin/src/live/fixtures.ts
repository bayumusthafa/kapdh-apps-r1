import type { paths } from "@kapdh/contracts";
import { screen } from "@testing-library/react";
import createClient from "openapi-fetch";
import { inject } from "vitest";
import type { User } from "../test/utils";
import { nodeMultipartClasses, rawFetch } from "./http";

/**
 * Fixture API nyata jalur `test:live` (live/api-server.mjs, temuan audit D2-14). Sandi dibuat acak per proses API;
 * kode autentikator diminta dari kendali uji yang menghitungnya dari secret di proses API (secret tidak keluar).
 */
export interface LiveAdmin {
  email: string;
  password: string;
  name: string;
}

export type LiveAdminKey = "super" | "treasurer";

export interface LiveFixtures {
  /** Origin API (http://127.0.0.1:port); klien memakai `${origin}/api/v1`. */
  origin: string;
  /** Kendali uji (jam server, kode TOTP, berkas bukti). */
  control: string;
  admins: Record<LiveAdminKey, LiveAdmin>;
  alumni: {
    /** Alumni seed dev tanpa iuran sama sekali (kandidat pencatatan iuran D13). */
    unverified: { userId: string; name: string };
    /** Alumni seed dev yang sudah mengirim bukti iuran pendaftaran (menunggu verifikasi). */
    pending: { userId: string; name: string; paymentId: string };
  };
  paymentMethod: { id: string; provider: string };
}

declare module "vitest" {
  export interface ProvidedContext {
    kapdhLive: LiveFixtures;
  }
}

export const live = (): LiveFixtures => inject("kapdhLive");

async function control<T>(method: "GET" | "POST", path: string): Promise<T> {
  const res = await rawFetch(`${live().control}${path}`, { method });
  if (!res.ok) throw new Error(`kendali uji ${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Kode autentikator baru (langkah waktu server yang belum dipakai admin ini). */
export async function totpCode(admin: LiveAdminKey): Promise<string> {
  return (await control<{ code: string }>("POST", `/totp?admin=${admin}`)).code;
}

/** Majukan jam server (sesi, idle, TOTP); jam klien tidak berubah. */
export async function advanceServerClock(ms: number): Promise<void> {
  await control("POST", `/clock/advance?ms=${ms}`);
}

/** Gambar PNG valid (File Node, lihat nodeMultipartClasses) untuk unggahan bukti dari UI; diproses sharp di server. */
export async function proofFile(name = "mutasi-rekening.png"): Promise<File> {
  const res = await rawFetch(`${live().control}/proof.png`);
  const { File: NodeFile } = await nodeMultipartClasses();
  return new NodeFile([new Uint8Array(await res.arrayBuffer())], name, { type: "image/png" });
}

/** Masuk lewat UI web admin terhadap API nyata: email + sandi, lalu kode autentikator (AC F02-1, F02-2). */
export async function signInLive(user: User, admin: LiveAdminKey = "super"): Promise<HTMLElement> {
  const who = live().admins[admin];
  await user.type(await screen.findByLabelText(/^Email/), who.email);
  await user.type(screen.getByLabelText(/^Kata sandi/), who.password);
  await user.click(screen.getByRole("button", { name: "Masuk" }));
  await user.type(await screen.findByLabelText(/^Kode autentikator/), await totpCode(admin));
  await user.click(screen.getByRole("button", { name: "Verifikasi" }));
  return screen.findByRole("navigation", { name: "Menu admin" });
}

/**
 * Klien API bertipe untuk admin lain yang bertindak di luar UI (mis. memutus lebih dulu, AC F04-3). Memakai fetch
 * tanpa cookie jar UI sehingga sesi UI tidak terpengaruh.
 */
export async function adminApi(admin: LiveAdminKey) {
  const who = live().admins[admin];
  const client = createClient<paths>({ baseUrl: `${live().origin}/api/v1`, fetch: rawFetch });
  const login = await client.POST("/admin/auth/login", {
    body: { email: who.email, password: who.password },
  });
  if (!login.data) throw new Error(`login ${admin} gagal: ${JSON.stringify(login.error)}`);
  const mfa = await client.POST("/admin/auth/mfa", {
    body: { mfa_token: login.data.mfa_token, totp_code: await totpCode(admin) },
  });
  if (!mfa.data) throw new Error(`MFA ${admin} gagal: ${JSON.stringify(mfa.error)}`);
  const token = mfa.data.access_token;
  client.use({
    onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${token}`);
      return request;
    },
  });
  return client;
}
