import type { components } from "@kapdh/contracts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../components/ui/Button";
import { FormField } from "../components/ui/FormField";
import { Input } from "../components/ui/Input";
import { renderWithProviders, signInViaApi } from "../test/utils";
import { api } from "./client";
import type { ApiError } from "./errors";
import { authRequests, MOCK_CREDENTIALS, mockPayments, paymentRequests } from "./mocks";
import { useApiMutation, useApiQuery } from "./query";

type Fees = components["schemas"]["FeeSettings"];
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
    expect(await screen.findByText("total 26")).toBeInTheDocument();
    const list = () => paymentRequests.filter((r) => r.path === "/admin/payments");
    expect(list()).toHaveLength(1);
    expect(list()[0]!.background).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(30_500);
    });
    await waitFor(() => expect(list()).toHaveLength(2));
    expect(list()[1]!.background).toBe(true);
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
    // Jaringan putus: pesan offline, bukan logout.
    expect(await screen.findByRole("alert")).toHaveTextContent("Tidak dapat terhubung");

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
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function FeesHarness({ preAuth }: { preAuth: boolean }) {
  const fees = useApiQuery({
    queryKey: ["fees"],
    request: ({ signal, headers }) => api.GET("/admin/settings/fees", { signal, headers }),
  });
  const save = useApiMutation<Fees, Fees>({
    requiresReauth: preAuth,
    reauthReason: "Mengubah biaya iuran",
    successMessage: "Biaya tersimpan.",
    request: (v, ctx) =>
      api.PUT("/admin/settings/fees", {
        params: {
          header: {
            "If-Match": v.version,
            // Tanpa token pada percobaan pertama: server menjawab REAUTH_REQUIRED lalu dialog dibuka.
            "X-Reauth-Token": ctx.reauthToken ?? "",
          },
        },
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

describe("ReauthDialog + useApiMutation (AC F15-3, ARCHITECTURE §4.3)", () => {
  it("REAUTH_REQUIRED membuka dialog; setelah sandi+TOTP, permintaan diulang sekali dengan X-Reauth-Token", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<FeesHarness preAuth={false} />);
    await user.click(await screen.findByRole("button", { name: "Simpan biaya" }));

    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    expect(dialog).toHaveAccessibleDescription(/Mengubah biaya iuran/);
    const password = within(dialog).getByLabelText(/^Sandi/);
    expect(password).toHaveFocus();

    // Kode salah: dialog tetap terbuka dengan pesan.
    await user.type(password, MOCK_CREDENTIALS.password);
    await user.type(within(dialog).getByLabelText(/^Kode autentikator/), "000000");
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Sandi atau kode autentikator salah.");

    await user.type(within(dialog).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(within(dialog).getByRole("button", { name: "Konfirmasi" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status success")).toBeInTheDocument();
    expect(await screen.findByText("Biaya tersimpan.")).toBeInTheDocument();
    expect(authRequests.filter((r) => r.path === "/auth/reauth")).toHaveLength(2);
  });

  it("requiresReauth: dialog muncul sebelum percobaan pertama; batal = tidak ada permintaan dan tanpa toast galat", async () => {
    await signInViaApi();
    const user = userEvent.setup();
    renderWithProviders(<FeesHarness preAuth />);
    await user.click(await screen.findByRole("button", { name: "Simpan biaya" }));
    const dialog = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("status error")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Simpan biaya" })).toHaveFocus();
  });
});
