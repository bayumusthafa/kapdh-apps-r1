import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAuth } from "../../api/mocks";
import { auditRequests, mockAudit } from "../../api/mocks/audit";
import { openPage, section } from "../../test/governance";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import { describeFilter, EXPORT_POLL_MS } from "./AuditPage";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Majukan waktu satu siklus polling ekspor (dua kali agar interval yang baru dipasang ikut berjalan). */
async function advancePolling() {
  for (let i = 0; i < 2; i += 1)
    await act(async () => {
      vi.advanceTimersByTime(EXPORT_POLL_MS + 500);
    });
}

const entryQueries = () => auditRequests.filter((r) => r.path === "/admin/audit/entries");

async function applyAction(user: User, action: string) {
  const filter = await section("Filter audit");
  await user.type(within(filter).getByLabelText("Tindakan"), action);
  await user.click(within(filter).getByRole("button", { name: "Terapkan filter" }));
}

describe("audit (F-17, AC F17-2..F17-4; server tiruan)", () => {
  it("describeFilter meringkas filter berbahasa Indonesia", () => {
    expect(describeFilter({})).toBe("Tanpa filter (semua entri)");
    expect(describeFilter({ action: "payment.approved", effective_role: "admin" })).toBe(
      "peran Admin; tindakan payment.approved",
    );
  });

  it("AC F17-4: filter tindakan dikirim sebagai parameter server dan hasil tersaring", async () => {
    const user = userEvent.setup();
    await openPage(user, "/audit", "Audit");
    await screen.findByText("Menampilkan 25 dari 33");
    await applyAction(user, "payment.approved");
    await screen.findByText("Menampilkan 1 dari 1");
    expect(entryQueries().at(-1)?.query).toMatchObject({
      action: "payment.approved",
      sort: "created_at_desc",
    });
    const table = screen.getByRole("table", { name: "Entri audit" });
    expect(within(table).getByText("Ahmad Zulhadi")).toBeInTheDocument();
    expect(within(table).getByText("Admin")).toBeInTheDocument();
  });

  it("validasi filter: nama pelaku minimal 2 karakter dan batas akhir setelah batas awal", async () => {
    const user = userEvent.setup();
    await openPage(user, "/audit", "Audit");
    const filter = await section("Filter audit");
    const before = entryQueries().length;
    await user.type(within(filter).getByLabelText("Nama pelaku"), "a");
    fireEvent.change(within(filter).getByLabelText("Dari (WIB)"), { target: { value: "2026-10-12T10:00" } });
    fireEvent.change(within(filter).getByLabelText("Sebelum (WIB)"), {
      target: { value: "2026-10-11T10:00" },
    });
    await user.click(within(filter).getByRole("button", { name: "Terapkan filter" }));
    await waitFor(() =>
      expect(within(filter).getByLabelText("Nama pelaku")).toHaveAccessibleDescription(/minimal 2 karakter/),
    );
    expect(within(filter).getByLabelText("Sebelum (WIB)")).toHaveAccessibleDescription(
      /Batas akhir harus setelah batas awal/,
    );
    expect(entryQueries()).toHaveLength(before);
  });

  it("rentang waktu WIB dikirim sebagai UTC (from inklusif, to eksklusif)", async () => {
    const user = userEvent.setup();
    await openPage(user, "/audit", "Audit");
    const filter = await section("Filter audit");
    fireEvent.change(within(filter).getByLabelText("Dari (WIB)"), { target: { value: "2026-10-12T16:00" } });
    await user.click(within(filter).getByRole("button", { name: "Terapkan filter" }));
    await waitFor(() => expect(entryQueries().at(-1)?.query.from).toBe("2026-10-12T09:00:00.000Z"));
  });

  it("detail entri menampilkan pelaku, alasan dan before/after yang sudah disaring", async () => {
    const user = userEvent.setup();
    await openPage(user, "/audit", "Audit");
    await applyAction(user, "member.suspended");
    const table = await screen.findByRole("table", { name: "Entri audit" });
    await user.click(within(table).getByRole("button", { name: /Lihat detail member\.suspended/ }));
    const dialog = await screen.findByRole("dialog", { name: "Detail entri audit" });
    expect(await within(dialog).findByText("Spam berulang di grup")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Sebelum")).toHaveTextContent('"suspended_at": null');
    expect(within(dialog).getByLabelText("Sesudah")).toHaveTextContent("+6281234567890");
  });

  it("AC F17-4: ekspor memakai filter yang SAMA dengan pencarian; Diproses → Siap lewat polling latar; unduh meminta URL baru", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openPage(user, "/audit", "Audit");
    await applyAction(user, "payment.approved");
    await screen.findByText("Menampilkan 1 dari 1");
    const panel = await section("Ekspor CSV");
    expect(within(panel).getByText("tindakan payment.approved")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Ekspor CSV dengan filter ini" }));
    expect(await findToast("success", "Ekspor diminta")).toBeInTheDocument();
    expect(await within(panel).findByText("Diproses")).toBeInTheDocument();

    const post = auditRequests.find((r) => r.method === "POST");
    const searchFilter: Record<string, string> = { ...entryQueries().at(-1)!.query };
    delete searchFilter.sort;
    delete searchFilter.limit;
    expect(post?.body).toEqual(searchFilter);
    expect(post?.idempotencyKey).toBeTruthy();

    mockAudit.finishExports();
    const before = auditRequests.length;
    await advancePolling();
    expect(await within(panel).findByText("Siap")).toBeInTheDocument();
    expect(within(panel).getByText(/1 baris/)).toBeInTheDocument();
    const polls = auditRequests.slice(before).filter((r) => r.path === "/admin/audit/exports");
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((r) => r.background)).toBe(true);

    await user.click(within(panel).getByRole("button", { name: /^Unduh audit-/ }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open.mock.calls[0]?.[0]).toMatch(
      /^https:\/\/files\.kapdh\.test\/signed\/audit-\d{8}-[0-9a-f]{8}\.csv/,
    );
    expect(open.mock.calls[0]?.[2]).toContain("noopener");
    expect(auditRequests.some((r) => r.path.endsWith("/access"))).toBe(true);
  });

  it("ekspor yang melebihi batas baris gagal dengan alasan dan saran mempersempit filter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPage(user, "/audit", "Audit");
    const panel = await section("Ekspor CSV");
    expect(within(panel).getByText("Tanpa filter (semua entri)")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Ekspor CSV dengan filter ini" }));
    await within(panel).findByText("Diproses");
    mockAudit.finishExports();
    await advancePolling();
    expect(await within(panel).findByText("Gagal")).toBeInTheDocument();
    expect(within(panel).getByText(/melebihi batas baris ekspor; persempit filter/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Unduh/ })).toBeNull();
  });

  it("AC F17-4: berkas ekspor kedaluwarsa otomatis dan tidak dapat diunduh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openPage(user, "/audit", "Audit");
    await applyAction(user, "admin.invited");
    const panel = await section("Ekspor CSV");
    await user.click(within(panel).getByRole("button", { name: "Ekspor CSV dengan filter ini" }));
    await within(panel).findByText("Diproses");
    mockAudit.finishExports();
    mockAudit.expireExports();
    await advancePolling();
    expect(await within(panel).findByText("Kedaluwarsa")).toBeInTheDocument();
    expect(within(panel).getByText(/Berkas sudah dihapus otomatis/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Unduh/ })).toBeNull();
  });

  it("AC F17-2: tanpa audit.export panel ekspor tidak ada; tanpa audit.read halaman menolak tanpa memanggil API", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["audit.read"] });
    const user = userEvent.setup();
    const first = await openPage(user, "/audit", "Audit");
    await screen.findByText("Menampilkan 25 dari 33");
    expect(screen.queryByRole("region", { name: "Ekspor CSV" })).toBeNull();
    expect(auditRequests.some((r) => r.path.startsWith("/admin/audit/exports"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await screen.findByLabelText(/^Kata sandi/);
    first.unmount();

    auditRequests.length = 0;
    mockAuth.setAdmin({ role: "admin", permissions: ["audit.export"] });
    renderApp("/audit");
    await signIn(user);
    expect(await screen.findByText(/memerlukan izin Lihat audit/)).toBeInTheDocument();
    expect(auditRequests).toHaveLength(0);
  });
});
