import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import { MOCK_REPORT_IDS, mockModeration, moderationRequests } from "../../api/mocks/moderation";
import { openPage, section } from "../../test/governance";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import { actionOptions } from "./ReportDetailPage";

/** Nilai StatCard berlabel `label` di dalam `region` (angka ditulis sebelum label). */
function statValue(region: HTMLElement, label: string): string {
  const el = within(region).getByText(label, { selector: "span" });
  return el.previousElementSibling?.textContent ?? "";
}

async function openReport(user: User, id: string, title: string | RegExp) {
  return openPage(user, `/moderation/${id}`, title);
}

const resolveCalls = () =>
  moderationRequests.filter((r) => r.method === "POST" && r.path.endsWith("/resolve"));

async function decide(user: User, action: RegExp, note: string, memberMessage?: string) {
  const card = await section("Putuskan laporan");
  await user.click(within(card).getByRole("radio", { name: action }));
  await user.type(within(card).getByLabelText(/^Catatan internal/), note);
  if (memberMessage !== undefined)
    await user.type(within(card).getByLabelText(/^Pesan untuk/), memberMessage);
  await user.click(within(card).getByRole("button", { name: "Putuskan laporan" }));
  return card;
}

describe("moderasi (F-12, AC F12-2..F12-5; server tiruan)", () => {
  it("AC F12-2: antrean bawaan aktif urut paling mendesak; laporan terhadap akun tertaut admin tidak pernah tampil", async () => {
    const user = userEvent.setup();
    await openPage(user, "/moderation", "Moderasi");
    const table = await screen.findByRole("table", { name: "Antrean laporan moderasi" });
    // 6 laporan aktif terlihat; laporan terhadap akun tertaut pemanggil dikecualikan dari item dan total.
    expect(screen.getByText("Menampilkan 6 dari 6")).toBeInTheDocument();
    expect(within(table).queryByText("Bayu Musthafa Arief")).toBeNull();
    const rows = within(table).getAllByRole("row").slice(1);
    // Urut due_at naik: ancaman (lewat target 6 jam) paling atas.
    expect(
      within(rows[0]!).getByRole("link", { name: /Ancaman\/keselamatan terhadap Arya Kamandanu/ }),
    ).toBeVisible();
    expect(within(rows[0]!).getByText("Mendesak")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Lewat target")).toBeInTheDocument();
    // Antrean tidak memuat identitas pelapor (minimisasi PRD 3.12).
    expect(within(table).queryByRole("columnheader", { name: /Pelapor/ })).toBeNull();

    const summary = screen.getByRole("region", { name: "Ringkasan antrean" });
    expect(statValue(summary, "Terbuka")).toBe("5");
    expect(statValue(summary, "Sedang ditinjau")).toBe("1");
    expect(statValue(summary, "Lewat target")).toBe("2");
    expect(statValue(summary, "Mendesak")).toBe("1");

    const first = moderationRequests.find((r) => r.path === "/admin/reports");
    expect(first?.query).toMatchObject({ status: "active", sort: "due", limit: "20" });
  });

  it("filter status, prioritas dan pencarian dikirim sebagai parameter server", async () => {
    const user = userEvent.setup();
    await openPage(user, "/moderation", "Moderasi");
    await screen.findByText("Menampilkan 6 dari 6");
    await user.selectOptions(screen.getByLabelText("Status"), "resolved");
    await screen.findByText("Menampilkan 1 dari 1");
    await user.selectOptions(screen.getByLabelText("Prioritas"), "urgent");
    await screen.findByText(/Tidak ada laporan yang cocok/);
    await user.selectOptions(screen.getByLabelText("Status"), "all");
    await user.type(screen.getByLabelText("Cari pihak terlapor"), "arya");
    await screen.findByText("Menampilkan 1 dari 1");
    await waitFor(() =>
      expect(moderationRequests.at(-1)?.query).toMatchObject({
        status: "all",
        priority: "urgent",
        q: "arya",
      }),
    );
  });

  it("AC F12-3: detail menampilkan bukti terminimalkan (pesan dilaporkan + konteks) dan riwayat pihak terlapor", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.threat, "Laporan Ancaman/keselamatan");
    const evidence = await section("Bukti");
    const list = within(evidence).getByRole("list", { name: "Pesan bukti" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText("Pesan yang dilaporkan")).toBeInTheDocument();
    expect(
      within(items[1]!).getByText(/Pesan asli sudah dihapus setelah laporan dibuat/),
    ).toBeInTheDocument();
    expect(within(items[0]!).getByText("Konteks")).toBeInTheDocument();
    const target = await section("Pihak terlapor");
    expect(within(target).getByText("Arya Kamandanu (10.02.01.3)")).toBeInTheDocument();
    expect(within(target).getByText("Belum ada peringatan atau suspend.")).toBeInTheDocument();
  });

  it("AC F12-3: peringatan wajib catatan dan pesan untuk anggota; keputusan memakai If-Match dan Idempotency-Key", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.threat, "Laporan Ancaman/keselamatan");
    const card = await section("Putuskan laporan");
    await user.click(within(card).getByRole("radio", { name: /^Peringatkan/ }));
    await user.click(within(card).getByRole("button", { name: "Putuskan laporan" }));
    await waitFor(() =>
      expect(within(card).getByLabelText(/^Catatan internal/)).toHaveAccessibleDescription(
        /minimal 3 karakter/,
      ),
    );
    expect(resolveCalls()).toHaveLength(0);

    await user.type(within(card).getByLabelText(/^Catatan internal/), "Ancaman kekerasan di grup");
    await user.click(within(card).getByRole("button", { name: "Putuskan laporan" }));
    await waitFor(() =>
      expect(within(card).getByLabelText(/^Pesan untuk anggota/)).toHaveAccessibleDescription(
        /minimal 3 karakter/,
      ),
    );
    await user.type(within(card).getByLabelText(/^Pesan untuk anggota/), "Jangan mengancam anggota lain.");
    await user.click(within(card).getByLabelText(/Jadikan pesan terlapor placeholder/));
    await user.click(within(card).getByRole("button", { name: "Putuskan laporan" }));

    const dialog = await screen.findByRole("alertdialog", { name: /Peringatkan laporan ini/ });
    expect(within(dialog).getByText(/Tanggal keanggotaan tidak berubah/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Ya, peringatkan" }));

    const decision = await section("Keputusan");
    expect(within(decision).getByText("Peringatkan")).toBeInTheDocument();
    expect(within(decision).getByText("Ya (placeholder)")).toBeInTheDocument();
    const call = resolveCalls()[0]!;
    expect(call.ifMatch).toBe("1");
    expect(call.idempotencyKey).toBeTruthy();
    expect(call.body).toEqual({
      action: "warn",
      note: "Ancaman kekerasan di grup",
      member_message: "Jangan mengancam anggota lain.",
      remove_message: true,
    });
    expect(screen.queryByRole("region", { name: "Putuskan laporan" })).toBeNull();
    expect(mockModeration.get(MOCK_REPORT_IDS.threat)?.status).toBe("resolved");
  });

  it("AC F12-4: suspend butuh konfirmasi dua langkah dan mengirim confirm: true", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.harassment, "Laporan Pelecehan");
    await decide(
      user,
      /^Suspend/,
      "Pelecehan berulang setelah peringatan",
      "Akun dibatasi karena pelecehan.",
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Suspend laporan ini/ });
    expect(within(dialog).getByText(/sesi umum anggota dicabut/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Ya, suspend" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/Saya sudah memeriksa bukti/));
    await user.click(confirm);

    const target = await section("Pihak terlapor");
    await within(target).findByText("Disuspend sejak");
    expect(within(target).getByText("Akun dibatasi karena pelecehan.")).toBeInTheDocument();
    expect(resolveCalls()[0]?.body).toMatchObject({
      action: "suspend",
      confirm: true,
      remove_message: false,
    });
    expect(resolveCalls()[0]?.ifMatch).toBe("2");
  });

  it("AC F12-5: banding dikabulkan mencabut suspend dan status dihitung ulang dari masa aktif", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.appeal, "Laporan Banding");
    const evidence = await section("Bukti");
    expect(within(evidence).getByText("Masih berlaku")).toBeInTheDocument();
    const card = await section("Putuskan laporan");
    // Banding hanya dapat ditolak atau dikabulkan.
    expect(
      within(card)
        .getAllByRole("radio")
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual(["dismiss", "unsuspend"]);
    await decide(user, /^Kabulkan banding/, "Akun terbukti diretas", "Suspend Anda dicabut.");
    const dialog = await screen.findByRole("alertdialog", { name: /Cabut suspend laporan ini/ });
    expect(within(dialog).getByText(/bukan otomatis terverifikasi/)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Saya sudah memeriksa bukti/));
    await user.click(within(dialog).getByRole("button", { name: "Ya, cabut suspend" }));

    const target = await section("Pemohon");
    await waitFor(() => expect(within(target).queryByText("Disuspend sejak")).toBeNull());
    expect(within(target).getByText("KTA Aktif")).toBeInTheDocument();
    expect(resolveCalls()[0]?.body).toMatchObject({ action: "unsuspend", confirm: true });
  });

  it("banding usang hanya dapat ditutup sebagai dikabulkan tanpa mengubah keanggotaan", () => {
    const stale = mockModeration.get(MOCK_REPORT_IDS.staleAppeal)!;
    expect(actionOptions(stale).map((o) => o.value)).toEqual(["unsuspend"]);
    const appeal = mockModeration.get(MOCK_REPORT_IDS.appeal)!;
    expect(actionOptions(appeal).map((o) => o.value)).toEqual(["dismiss", "unsuspend"]);
    const harassment = mockModeration.get(MOCK_REPORT_IDS.harassment)!;
    expect(actionOptions(harassment).map((o) => o.value)).toEqual(["dismiss", "warn", "suspend"]);
  });

  it("laporan grup tanpa subjek: warn mewajibkan memilih anggota grup", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.groupSpam, "Laporan Spam");
    const card = await decide(user, /^Peringatkan/, "Promosi investasi bodong", "Grup bukan tempat promosi.");
    await waitFor(() =>
      expect(within(card).getByLabelText(/^Anggota grup yang dikenai tindakan/)).toHaveAccessibleDescription(
        /Pilih anggota grup/,
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.selectOptions(
      within(card).getByLabelText(/^Anggota grup yang dikenai tindakan/),
      "Dimas Prasetyo",
    );
    await user.click(within(card).getByRole("button", { name: "Putuskan laporan" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Peringatkan laporan ini/ });
    await user.click(within(dialog).getByRole("button", { name: "Ya, peringatkan" }));
    await section("Keputusan");
    expect(resolveCalls()[0]?.body).toMatchObject({
      action: "warn",
      subject_user_id: "0199e000-0000-7000-8000-0000000000c7",
    });
  });

  it("klaim mengirim If-Match dan menandai admin sebagai peninjau", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.threat, "Laporan Ancaman/keselamatan");
    const card = await section("Peninjauan");
    await user.click(within(card).getByRole("button", { name: "Klaim untuk ditinjau" }));
    expect(await screen.findByText("Anda sedang meninjau laporan ini.")).toBeInTheDocument();
    const claim = moderationRequests.find((r) => r.path.endsWith("/claim"));
    expect(claim?.ifMatch).toBe("1");
    expect(claim?.idempotencyKey).toBeTruthy();
    const summary = await section("Ringkasan");
    expect(within(summary).getByText(/Bayu Musthafa sejak/)).toBeInTheDocument();
  });

  it("409: keputusan pengurus lain yang lebih dulu dimuat ulang tanpa menimpa", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.threat, "Laporan Ancaman/keselamatan");
    mockModeration.resolveElsewhere(MOCK_REPORT_IDS.threat);
    await decide(user, /^Abaikan/, "Tidak melanggar");
    const dialog = await screen.findByRole("alertdialog", { name: /Abaikan laporan ini/ });
    await user.click(within(dialog).getByRole("button", { name: "Ya, abaikan" }));
    expect(await screen.findByText(/sudah diubah atau diputus pengurus lain/)).toBeInTheDocument();
    const decision = await section("Keputusan");
    expect(within(decision).getByText("Ahmad Zulhadi")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Putuskan laporan" })).toBeNull();
    expect(await findToast("error", /sudah diputus atau diubah/)).toBeInTheDocument();
  });

  it("AC F12-2: laporan yang dibuat akun tertaut admin dapat dibaca tetapi tidak dapat diklaim atau diputus", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.ownReport, "Laporan Lainnya");
    expect(screen.getByRole("note")).toHaveTextContent(/harus dilakukan pengurus lain/);
    expect(screen.queryByRole("region", { name: "Putuskan laporan" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Peninjauan" })).toBeNull();
  });

  it("AC F12-2: laporan terhadap akun tertaut admin dijawab tidak ditemukan", async () => {
    const user = userEvent.setup();
    await openReport(user, MOCK_REPORT_IDS.againstSelf, "Detail Laporan");
    expect(await screen.findByText("Laporan tidak ditemukan.")).toBeInTheDocument();
    expect(screen.queryByText("Bayu Musthafa Arief")).toBeNull();
  });

  it("izin: moderation.read saja hanya membaca; tanpa moderation.read halaman menolak tanpa memanggil API", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["moderation.read"] });
    const user = userEvent.setup();
    const first = await openReport(user, MOCK_REPORT_IDS.threat, "Laporan Ancaman/keselamatan");
    expect(
      await screen.findByText(/Klaim dan keputusan memerlukan izin Menyelesaikan laporan moderasi/),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "Putuskan laporan" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Klaim/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await screen.findByLabelText(/^Kata sandi/);
    first.unmount();

    moderationRequests.length = 0;
    mockAuth.setAdmin({ role: "admin", permissions: ["moderation.resolve"] });
    renderApp("/moderation");
    await signIn(user);
    expect(await screen.findByText(/memerlukan izin Membaca laporan moderasi/)).toBeInTheDocument();
    expect(moderationRequests).toHaveLength(0);
  });

  it("izin: admin tanpa izin moderasi tidak dapat membuka rute", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    renderApp("/moderation");
    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(moderationRequests).toHaveLength(0);
  });
});
