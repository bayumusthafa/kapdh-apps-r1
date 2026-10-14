import { type Permission, PERMISSION_VALUES } from "@kapdh/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import adminPaymentsYaml from "../../../../../packages/contracts/openapi/domains/admin-payments.yaml?raw";
import adminSettingsYaml from "../../../../../packages/contracts/openapi/domains/admin-settings.yaml?raw";
import { MOCK_CREDENTIALS, mockAuth } from "./auth";
import { mockFetch } from "./index";
import { routes } from "./payments";

/**
 * Server tiruan pembayaran wajib mengikuti `x-kapdh-access` kontrak final (ARCHITECTURE §4.3): setiap izin yang
 * tercantum diperiksa, reautentikasi hanya untuk operasi `reauth: true`. Uji ini membaca berkas domain kontrak
 * sehingga perubahan akses di kontrak langsung terlihat sebagai kegagalan di sini (mock bukan bukti AC, PRD 7.3).
 */
interface ContractOperation {
  method: string;
  path: string;
  operationId: string;
  audience: string | null;
  permissions: Permission[];
  reauth: boolean;
  idempotent: boolean;
}

/** Pengurai baris sederhana untuk bagian `paths` berkas domain (format kontrak yang ditulis tangan dan konsisten). */
function parseOperations(yaml: string): ContractOperation[] {
  const ops: ContractOperation[] = [];
  let path: string | null = null;
  let method: string | null = null;
  let operationId: string | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^components:/.test(line)) break;
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p) {
      path = p[1]!;
      continue;
    }
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m) {
      method = m[1]!.toUpperCase();
      operationId = null;
      continue;
    }
    const o = /^ {6}operationId:\s*(\w+)/.exec(line);
    if (o) {
      operationId = o[1]!;
      continue;
    }
    const a = /^ {6}x-kapdh-access:\s*\{(.*)\}\s*$/.exec(line);
    if (a && path && method && operationId) {
      const body = a[1]!;
      ops.push({
        method,
        path,
        operationId,
        audience: /audience:\s*(\w+)/.exec(body)?.[1] ?? null,
        permissions: (/permissions:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as Permission[],
        reauth: /reauth:\s*true/.test(body),
        idempotent: /idempotent:\s*true/.test(body),
      });
    }
  }
  return ops;
}

/** Operasi kontrak yang dipakai halaman /payments dan karenanya wajib ditiru server tiruan. */
const USED_BY_UI = [
  "adminListPayments",
  "adminGetPaymentSummary",
  "adminGetPayment",
  "adminDecidePayment",
  "adminCancelPayment",
  "adminCreatePaymentAdjustment",
  "adminListPaymentAdjustments",
  "adminGetPaymentAdjustment",
  "adminUpdatePaymentAdjustment",
  "adminCompletePaymentAdjustment",
  "adminCancelPaymentAdjustment",
  "adminListPaymentMethods",
  "adminCreatePaymentMethod",
  "adminGetPaymentMethod",
  "adminUpdatePaymentMethod",
  "adminDeletePaymentMethod",
  "adminGetFees",
  "adminUpdateFees",
];

const contract = [...parseOperations(adminPaymentsYaml), ...parseOperations(adminSettingsYaml)];
const implemented = contract.filter((op) => routes.some((r) => r.method === op.method && r.path === op.path));

/** Id data contoh tanpa konflik kepentingan untuk parameter path. */
const PATH_PARAMS: Record<string, string> = {
  paymentId: "0199e000-0000-7000-8000-0000000000a2",
  adjustmentId: "0199e000-0000-7000-8000-000000000502",
  methodId: "0199e000-0000-7000-8000-000000000002",
};

let accessToken = "";

async function call(op: ContractOperation, headers: Record<string, string> = {}) {
  const url = `http://localhost/api/v1${op.path.replace(/\{(\w+)\}/g, (_, k: string) => PATH_PARAMS[k]!)}`;
  const res = await mockFetch(
    new Request(url, {
      method: op.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(op.method === "GET" || op.method === "DELETE" ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: op.method === "GET" || op.method === "DELETE" ? undefined : "{}",
    }),
  );
  const body = res.status === 204 ? null : ((await res.json()) as { code?: string } | null);
  return { status: res.status, code: body?.code ?? null };
}

async function signIn(): Promise<void> {
  const login = await mockFetch(
    new Request("http://localhost/api/v1/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password }),
    }),
  );
  const { mfa_token } = (await login.json()) as { mfa_token: string };
  const mfa = await mockFetch(
    new Request("http://localhost/api/v1/admin/auth/mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mfa_token, totp_code: MOCK_CREDENTIALS.totp }),
    }),
  );
  accessToken = ((await mfa.json()) as { access_token: string }).access_token;
}

beforeEach(async () => {
  await signIn();
});

describe("server tiruan pembayaran mengikuti x-kapdh-access kontrak (ARCHITECTURE §4.3)", () => {
  it("setiap operasi yang dipakai halaman /payments ditiru dengan method dan path kontrak", () => {
    const ids = implemented.map((op) => op.operationId);
    expect(ids).toEqual(expect.arrayContaining(USED_BY_UI));
    // Semua route tiruan berasal dari kontrak (tidak ada path karangan).
    for (const r of routes)
      expect(
        contract.some((op) => op.method === r.method && op.path === r.path),
        `${r.method} ${r.path}`,
      ).toBe(true);
  });

  it("AC F15-1, F16-3: tanpa salah satu izin kontrak → 403 FORBIDDEN; dengan izin kontrak saja → tidak FORBIDDEN", async () => {
    for (const op of implemented) {
      expect(op.audience, op.operationId).toBe("admin");
      expect(op.permissions.length, op.operationId).toBeGreaterThan(0);
      for (const missing of op.permissions) {
        mockAuth.setAdmin({ role: "admin", permissions: PERMISSION_VALUES.filter((p) => p !== missing) });
        const res = await call(op, { "X-Reauth-Token": "tidak-dipakai" });
        expect({ op: op.operationId, missing, status: res.status, code: res.code }).toMatchObject({
          status: 403,
          code: "FORBIDDEN",
        });
      }
      mockAuth.setAdmin({ role: "admin", permissions: [...op.permissions] });
      const allowed = await call(op);
      expect({ op: op.operationId, code: allowed.code }).not.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("AC F15-3: operasi reauth menolak tanpa X-Reauth-Token; operasi lain tidak meminta reautentikasi", async () => {
    mockAuth.setAdmin({ role: "super_admin", permissions: [] });
    for (const op of implemented) {
      const res = await call(op);
      if (op.reauth)
        expect({ op: op.operationId, code: res.code }).toEqual({
          op: op.operationId,
          code: "REAUTH_REQUIRED",
        });
      else expect({ op: op.operationId, code: res.code }).not.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    // Operasi sensitif F-15 menurut kontrak: metode bayar dan biaya.
    expect(implemented.filter((op) => op.reauth).map((op) => op.operationId)).toEqual(
      expect.arrayContaining([
        "adminCreatePaymentMethod",
        "adminUpdatePaymentMethod",
        "adminDeletePaymentMethod",
        "adminUpdateFees",
      ]),
    );
  });
});
