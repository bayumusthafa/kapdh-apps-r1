import type { components } from "@kapdh/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../auth/session";
import { Button } from "../components/ui/Button";
import { FormField } from "../components/ui/FormField";
import { Input } from "../components/ui/Input";
import { findToast, renderWithProviders, signInViaApi, toasts } from "../test/utils";
import { api } from "./client";
import type { ApiError } from "./errors";
import { authRequests, MOCK_CREDENTIALS, mockAuth, mockPayments, paymentRequests } from "./mocks";
import { accountRequests } from "./mocks/account";
import { useApiMutation, useApiQuery } from "./query";

type Fees = components["schemas"]["FeeSettings"];
type BackupCodes = components["schemas"]["AdminBackupCodes"];
const AHMAD = "0199e000-0000-7000-8000-0000000000a2";

afterEach(() => {
  vi.useRealTimers();
});

function PollingList() {
  const q = useApiQuery({
    queryKey: ["admin-payments", "test"],
    pollMs: 30_000,
    request: ({ signal, headers }) =>
      api.GET("/admin/payments", { params: { query: { limit: 5 } }, signal, headers }),
  });
  return <p>{q.data ? `total ${q.data.total}` : "memuat"}</p>;
}

describe("useApiQuery", () => {
  it("AC F02-5: muat pertama tanpa header latar, refetch polling dengan X-Background-Request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await signInViaApi();
    renderWithProviders(<PollingList />);
    expect(await screen.findByText("total 29")).toBeInTheDocument();
    const list = () => paymentRequests.filter((r) => r.path === "/admin/payments");
    expect(list()).toHaveLength(1);
    expect(list()[0]!.background).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(30_500);
    });
    await waitFor(() => expect(list()).toHaveLength(2));
    expect(list()[1]!.background).toBe(true);
  });

  it("AC F02-5: percobaan ulang refetch polling dan refetch saat kembali online tetap berlabel latar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await signInViaApi();
    const sent: Record<string, string>[] = [];
    function FlakyPolling() {
      const q = useApiQuery({
        queryKey: ["admin-payments", "flaky"],
        pollMs: 30_000,
        retry: 1,
        retryDelay: 10,
        request: ({ signal, headers }) => {
          sent.push(headers);
          // Panggilan kedua (refetch polling pertama) gagal 503 dari proxy, lalu diulang otomatis.
          if (sent.length === 2)
            return Promise.resolve({ error: undefined, response: new Response(null, { status: 503 }) });
          return api.GET("/admin/payments", { params: { query: { limit: 5 } }, signal, headers });
        },
      });
      return <p>{q.data ? `total ${q.data.total}` : "memuat"}</p>;
    }
    renderWithProviders(<FlakyPolling />);
    expect(await screen.findByText("total 29")).toBeInTheDocument();
    expect(sent[0]).toEqual({});
    await act(async () => {
      vi.advanceTimersByTime(30_500);
    });
    await waitFor(() => expect(sent).toHaveLength(3));
    // Polling yang gagal dan percobaan ulangnya sama-sama permintaan latar.
    expect(sent[1]).toEqual({ "X-Background-Request": "1" });
    expect(sent[2]).toEqual({ "X-Background-Request": "1" });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]).toEqual({ "X-Background-Request": "1" });
  });

  it("galat API dilempar sebagai ApiError bertipe dengan aksi katalog ERROR_UI", async () => {
    await signInViaApi();
    let captured: ApiError | null = null;
    function Missing() {
      const q = useApiQuery({
        queryKey: ["admin-payment", "tidak-ada"],
        request: ({ signal, headers }) =>
          api.GET("/admin/payments/{paymentId}", {
            params: { path: { paymentId: "tidak-ada" } },
            signal,
            headers,
          }),
      });
      if (q.error) captured = q.error;
      return <p>{q.status}</p>;
    }
    renderWithProviders(<Missing />);
    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(captured).toMatchObject({ code: "NOT_FOUND", status: 404, ui: { action: "show_not_found" } });
  });
});

function DecisionHarness({ onReload }: { onReload?: () => void }) {
  const keys = useState<string[]>([])[0];
  const [failNext, setFailNext] = useState(false);
  const decide = useApiMutation<
    components["schemas"]["AdminPaymentDetail"],
    { version: string; reason: string }
  >({
    intent: (v) => v,
    onReloadLatest: () => onReload?.(),
    request: async (v, ctx) => {
      keys.push(ctx.idempotencyKey);
      if (failNext) {
        setFailNext(false);
        throw new TypeError("Failed to fetch");
      }
      const p = mockPayments.get(AHMAD)!;
      return api.POST("/admin/payments/{paymentId}/decision", {
        params: { path: { paymentId: AHMAD }, header: { "Idempotency-Key": ctx.idempotencyKey } },
        body: {
          decision: "reject",
          expected_proof_version: p.proof_version,
          expected_version: v.version,
          reason: v.reason,
        },
      });
    },
  });
  return (
    <div>
      <Button onClick={() => setFailNext(true)}>Putus jaringan</Button>
      <Button onClick={() => decide.mutate({ version: "1", reason: "Foto buram" })}>Tolak v1</Button>
      <Button onClick={() => decide.mutate({ version: "9", reason: "Foto buram" })}>Tolak v9</Button>
      <output data-testid="keys">{keys.join(",")}</output>
      <p>{decide.status}</p>
    </div>
  );
}

describe("useApiMutation", () => {
  it("PRD 4.3: Idempotency-Key sama saat hasil belum diketahui (jaringan), baru setelah hasil pasti", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    const onReload = vi.fn();
    renderWithProviders(<DecisionHarness onReload={onReload} />);
    await user.click(screen.getByRole("button", { name: "Putus jaringan" }));
    await user.click(screen.getByRole("button", { name: "Tolak v9" }));
    expect(await screen.findByText("error")).toBeInTheDocument();
    // Jaringan putus: pesan offline (toast galat di wadah aria-live assertive), bukan logout.
    expect(await findToast("error", "Tidak dapat terhubung")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tolak v9" }));
    // Konflik versi (409) = hasil pasti; data terbaru dimuat ulang (AC F15-4).
    await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Tolak v9" }));
    await waitFor(() => expect(paymentRequests.filter((r) => r.method === "POST")).toHaveLength(2));

    const posts = paymentRequests.filter((r) => r.method === "POST").map((r) => r.idempotencyKey);
    // Percobaan 1 (gagal jaringan, tidak sampai server) dan 2 memakai key yang sama; percobaan 3 key baru.
    const keys = screen.getByTestId("keys").textContent!.split(",");
    expect(keys[0]).toBe(keys[1]);
    expect(posts[0]).toBe(keys[1]);
    expect(posts[1]).not.toBe(posts[0]);
  });

  it("niat berbeda (versi lain) memakai Idempotency-Key berbeda", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<DecisionHarness />);
    await user.click(screen.getByRole("button", { name: "Tolak v9" }));
    await screen.findByText("error");
    await user.click(screen.getByRole("button", { name: "Tolak v1" }));
    await screen.findByText("success");
    const posts = paymentRequests.filter((r) => r.method === "POST").map((r) => r.idempotencyKey);
    expect(posts).toHaveLength(2);
    expect(posts[0]).not.toBe(posts[1]);
  });

  it("show_field_errors: field_errors VALIDATION_ERROR dipasang ke isian formulir, bukan toast", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    function ReasonForm() {
      const form = useForm<{ reason: string }>({ defaultValues: { reason: "  " } });
      const decide = useApiMutation<unknown, { reason: string }, { reason: string }>({
        setError: form.setError,
        request: (v, ctx) =>
          api.POST("/admin/payments/{paymentId}/decision", {
            params: { path: { paymentId: AHMAD }, header: { "Idempotency-Key": ctx.idempotencyKey } },
            body: { decision: "reject", expected_proof_version: 1, expected_version: "1", reason: v.reason },
          }),
      });
      return (
        <form onSubmit={form.handleSubmit((v) => decide.mutate(v))}>
          <FormField<{ reason: string }, "reason"> control={form.control} name="reason" label="Alasan">
            {(field, a11y) => <Input {...field} {...a11y} />}
          </FormField>
          <Button type="submit">Kirim</Button>
        </form>
      );
    }
    renderWithProviders(<ReasonForm />);
    await user.click(screen.getByRole("button", { name: "Kirim" }));
    const input = await screen.findByRole("textbox", { name: "Alasan" });
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAccessibleDescription("Alasan minimal 3 karakter dan tidak boleh hanya spasi.");
    // Fokus pindah ke isian bergalat sehingga pembaca layar membacakan galatnya; tidak perlu toast (N-11).
    expect(input).toHaveFocus();
    expect(toasts("error")).toHaveLength(0);
  });

  it("show_field_errors: isian bergalat yang tidak dapat difokus diumumkan lewat toast ringkasan", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    function HiddenFieldForm() {
      // Isian "reason" tidak dirender (mis. berada di dialog yang sudah ditutup): fokus tidak dapat dipindah.
      const form = useForm<{ reason: string }>({ defaultValues: { reason: "  " } });
      const decide = useApiMutation<unknown, { reason: string }, { reason: string }>({
        setError: form.setError,
        request: (v, ctx) =>
          api.POST("/admin/payments/{paymentId}/decision", {
            params: { path: { paymentId: AHMAD }, header: { "Idempotency-Key": ctx.idempotencyKey } },
            body: { decision: "reject", expected_proof_version: 1, expected_version: "1", reason: v.reason },
          }),
      });
      return <Button onClick={() => decide.mutate({ reason: "  " })}>Kirim tanpa isian</Button>;
    }
    renderWithProviders(<HiddenFieldForm />);
    await user.click(screen.getByRole("button", { name: "Kirim tanpa isian" }));
    expect(
      await findToast("error", "Periksa isian yang ditandai. Alasan minimal 3 karakter"),
    ).toBeInTheDocument();
  });
});

/**
 * Tindakan kredensial yang kontraknya `reauth: true` (POST /admin/auth/backup-codes, ADR-025). `preAuth` = dialog
 * proaktif sebelum percobaan pertama; tanpa itu percobaan pertama dikirim tanpa token sehingga server menjawab
 * REAUTH_REQUIRED dan penanganan generik useApiMutation membuka dialog lalu mengulang sekali.
 */
function BackupCodesHarness({ preAuth }: { preAuth: boolean }) {
  const regenerate = useApiMutation<BackupCodes, void>({
    requiresReauth: preAuth,
    reauthReason: "Membuat ulang backup code",
    successMessage: "Backup code dibuat ulang.",
    request: (_v, ctx) =>
      api.POST("/admin/auth/backup-codes", {
        // Tanpa token pada percobaan pertama: server menjawab REAUTH_REQUIRED lalu dialog dibuka.
        params: { header: { "X-Reauth-Token": ctx.reauthToken ?? "" } },
      }),
  });
  return (
    <div>
      <p>status {regenerate.status}</p>
      <Button onClick={() => regenerate.mutate()}>Buat ulang backup code</Button>
    </div>
  );
}

/** Perubahan non-kredensial (PUT /admin/settings/fees): tanpa requiresReauth dan tanpa X-Reauth-Token (ADR-025). */
function FeesHarness() {
  const fees = useApiQuery({
    queryKey: ["fees"],
    request: ({ signal, headers }) => api.GET("/admin/settings/fees", { signal, headers }),
  });
  const save = useApiMutation<Fees, Fees>({
    successMessage: "Biaya tersimpan.",
    request: (v) =>
      api.PUT("/admin/settings/fees", {
        params: { header: { "If-Match": v.version } },
        body: { registration_fee: v.registration_fee, card_fee: v.card_fee, renewal_fee: "15000.00" },
      }),
  });
  if (!fees.data) return <p>memuat</p>;
  return (
    <div>
      <p>Perpanjangan {fees.data.renewal_fee}</p>
      <p>status {save.status}</p>
      <Button onClick={() => save.mutate(fees.data)}>Simpan biaya</Button>
    </div>
  );
}

const backupCodePosts = () => accountRequests.filter((r) => r.path === "/admin/auth/backup-codes");

describe("ReauthDialog + useApiMutation (ARCHITECTURE §4.3, ADR-025)", () => {
  it("ADR-025: perubahan non-kredensial tersimpan tanpa dialog Konfirmasi identitas dan tanpa X-Reauth-Token", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<FeesHarness />);
    await user.click(await screen.findByRole("button", { name: "Simpan biaya" }));
    expect(await screen.findByText("status success")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull();
    const puts = paymentRequests.filter((r) => r.method === "PUT" && r.path === "/admin/settings/fees");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.reauthToken).toBeNull();
    expect(authRequests.filter((r) => r.path === "/auth/reauth")).toHaveLength(0);
  });

  it("REAUTH_REQUIRED membuka dialog; setelah sandi+TOTP, permintaan diulang sekali dengan X-Reauth-Token", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<BackupCodesHarness preAuth={false} />);
    await user.click(await screen.findByRole("button", { name: "Buat ulang backup code" }));

    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    expect(dialog).toHaveAccessibleDescription(/Membuat ulang backup code/);
    // Percobaan pertama tanpa token sudah ditolak server sebelum dialog dibuka.
    expect(backupCodePosts()).toHaveLength(1);
    const password = within(dialog).getByLabelText(/^Sandi/);
    expect(password).toHaveFocus();

    // Kode salah (400 VALIDATION_ERROR per isian, kontrak auth): dialog tetap terbuka, pesan di isian kode.
    await user.type(password, MOCK_CREDENTIALS.password);
    const code = within(dialog).getByLabelText(/^Kode autentikator/);
    await user.type(code, "000000");
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    await waitFor(() =>
      expect(code).toHaveAccessibleDescription(/Kode autentikator salah\. Sisa percobaan 4\./),
    );
    expect(code).toHaveValue("");

    await user.type(code, MOCK_CREDENTIALS.totp);
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status success")).toBeInTheDocument();
    expect(await screen.findByText("Backup code dibuat ulang.")).toBeInTheDocument();
    expect(authRequests.filter((r) => r.path === "/auth/reauth")).toHaveLength(2);
    // Diulang tepat sekali, kali ini dengan X-Reauth-Token.
    expect(backupCodePosts()).toHaveLength(2);
  });

  it("401 dari /auth/reauth karena token sudah diganti (bukan sandi salah): sesi diperiksa lalu dikirim ulang", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<BackupCodesHarness preAuth />);
    await user.click(await screen.findByRole("button", { name: "Buat ulang backup code" }));
    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    // Access token ditolak server (mis. sesi diputar tab lain) padahal cookie refresh masih berlaku.
    mockAuth.expireAccessTokens();
    await user.type(within(dialog).getByLabelText(/^Sandi/), MOCK_CREDENTIALS.password);
    await user.type(within(dialog).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status success")).toBeInTheDocument();
    expect(authRequests.filter((r) => r.path === "/auth/reauth")).toHaveLength(2);
    expect(screen.queryByText("Sandi atau kode autentikator salah.")).toBeNull();
  });

  it("sesi berakhir saat dialog reautentikasi terbuka: dialog ditutup, tindakan batal tanpa toast galat", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    function SaveOnly() {
      // Tidak bergantung pada data query: cache dibersihkan saat sesi berakhir.
      const save = useApiMutation<BackupCodes, void>({
        requiresReauth: true,
        reauthReason: "Membuat ulang backup code",
        request: (_v, ctx) =>
          api.POST("/admin/auth/backup-codes", {
            params: { header: { "X-Reauth-Token": ctx.reauthToken ?? "" } },
          }),
      });
      const auth = useAuth();
      return (
        <div>
          <p>sesi {auth.state.status}</p>
          <p>status {save.status}</p>
          <Button onClick={() => save.mutate()}>Buat ulang backup code</Button>
        </div>
      );
    }
    renderWithProviders(<SaveOnly />);
    await screen.findByText("sesi authenticated");
    await user.click(screen.getByRole("button", { name: "Buat ulang backup code" }));
    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    mockAuth.revokeSession();
    await user.type(within(dialog).getByLabelText(/^Sandi/), MOCK_CREDENTIALS.password);
    await user.type(within(dialog).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    // Bukan pesan "sandi salah" yang menjebak: dialog ditutup dan mutasi selesai sebagai dibatalkan.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status error")).toBeInTheDocument();
    expect(screen.getByText("sesi anonymous")).toBeInTheDocument();
    expect(screen.queryByText("Sandi atau kode autentikator salah.")).toBeNull();
    expect(toasts("error")).toHaveLength(0);
  });

  it("requiresReauth: dialog muncul sebelum percobaan pertama; batal = tidak ada permintaan dan tanpa toast galat", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<BackupCodesHarness preAuth />);
    await user.click(await screen.findByRole("button", { name: "Buat ulang backup code" }));
    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status error")).toBeInTheDocument();
    expect(toasts("error")).toHaveLength(0);
    expect(backupCodePosts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Buat ulang backup code" })).toHaveFocus();
  });
});
