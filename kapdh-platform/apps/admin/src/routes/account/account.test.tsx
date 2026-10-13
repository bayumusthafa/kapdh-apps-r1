import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MOCK_CREDENTIALS, mockAuth } from "../../api/mocks";
import { accountRequests, mockAccount } from "../../api/mocks/account";
import { mockCheckPassword, mockConsumeBackupCodes } from "../../api/mocks/auth";
import { confirmReauth, openPage, section } from "../../test/governance";
import { findToast, type User } from "../../test/utils";

const NEW_PASSWORD = "Sandi#Baru2027";

async function openAccount(user: User) {
  await openPage(user, "/account", "Akun saya");
}

describe("akun admin sendiri (F-02, AC F02-4, F02-6; server tiruan)", () => {
  it("menampilkan profil, email login, izin efektif dan login sebelumnya", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Profil admin");
    expect(within(card).getByText(MOCK_CREDENTIALS.email)).toBeInTheDocument();
    expect(within(card).getByText("Belum ada (ini login pertama)")).toBeInTheDocument();
    expect(within(within(card).getByRole("list", { name: "Daftar izin" })).getAllByRole("listitem")).toHaveLength(15);
  });

  it("AC F02-4: ganti sandi mensyaratkan sandi lama; salah tampil di isian; berhasil mencabut sesi lain", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Ganti sandi");
    const sessions = await section("Perangkat yang masuk");
    expect(await within(sessions).findByText("Firefox di Ubuntu")).toBeInTheDocument();

    const current = within(card).getByLabelText(/^Sandi saat ini/);
    await user.type(current, "SandiSalah#1");
    await user.type(within(card).getByLabelText(/^Sandi baru/), NEW_PASSWORD);
    await user.type(within(card).getByLabelText(/^Ulangi sandi baru/), NEW_PASSWORD);
    await user.click(within(card).getByRole("button", { name: "Ganti sandi" }));
    await waitFor(() => expect(current).toHaveAccessibleDescription(/Sandi saat ini salah\. Sisa percobaan 4\./));
    expect(current).toHaveValue("");

    await user.type(current, MOCK_CREDENTIALS.password);
    await user.click(within(card).getByRole("button", { name: "Ganti sandi" }));
    expect(await findToast("success", "Sesi di perangkat lain sudah dicabut")).toBeInTheDocument();
    expect(mockCheckPassword(NEW_PASSWORD)).toBe(true);
    await waitFor(() => expect(within(sessions).queryByText("Firefox di Ubuntu")).toBeNull());
    expect(within(sessions).getByText("Perangkat ini")).toBeInTheDocument();
    // Sesi saat ini tetap berlaku.
    expect(mockAuth.isSessionActive()).toBe(true);
  });

  it("PRD 2.5: sandi baru diperiksa dalam byte UTF-8 dan syarat lengkap sebelum dikirim", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Ganti sandi");
    await user.type(within(card).getByLabelText(/^Sandi saat ini/), MOCK_CREDENTIALS.password);
    const next = within(card).getByLabelText(/^Sandi baru/);
    await user.type(next, "Kapdh2026");
    await user.type(within(card).getByLabelText(/^Ulangi sandi baru/), "Kapdh2026");
    await user.click(within(card).getByRole("button", { name: "Ganti sandi" }));
    await waitFor(() => expect(next).toHaveAccessibleDescription(/wajib memuat simbol/));
    const rules = within(card).getByRole("list", { name: "Syarat sandi" });
    expect(within(rules).getByText(/Simbol/)).toHaveTextContent("belum terpenuhi");
    expect(accountRequests.some((r) => r.path === "/admin/auth/password/change")).toBe(false);
  });

  it("F-02: perangkat saat ini di atas dan tidak dicabut dari daftar; perangkat lain dikeluarkan setelah konfirmasi", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Perangkat yang masuk");
    const list = await within(card).findByRole("list", { name: "Daftar perangkat" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Perangkat ini");
    expect(within(items[0]!).queryByRole("button")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Keluarkan Firefox di Ubuntu" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Keluarkan perangkat ini/ });
    const confirm = within(dialog).getByRole("button", { name: "Keluarkan perangkat" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Saya memahami perangkat tersebut langsung keluar."));
    await user.click(confirm);
    expect(await findToast("success", "Firefox di Ubuntu sudah dikeluarkan.")).toBeInTheDocument();
    await waitFor(() => expect(within(card).queryByText("Firefox di Ubuntu")).toBeNull());
    expect(mockAccount.otherSessionCount()).toBe(1);
    expect(accountRequests.find((r) => r.method === "DELETE")?.path).toMatch(/^\/auth\/sessions\//);
  });

  it("AC F02-6: keluar dari semua perangkat mencabut semua sesi lalu kembali ke halaman masuk", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Perangkat yang masuk");
    await user.click(within(card).getByRole("button", { name: "Keluar dari semua perangkat" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Keluar dari semua perangkat/ });
    await user.click(within(dialog).getByLabelText("Saya memahami semua perangkat akan keluar."));
    await user.click(within(dialog).getByRole("button", { name: "Keluar dari semua perangkat" }));
    expect(await screen.findByRole("heading", { name: "Selamat Datang Kembali!" })).toBeInTheDocument();
    expect(mockAuth.isSessionActive()).toBe(false);
    expect(mockAccount.otherSessionCount()).toBe(0);
    expect(accountRequests.some((r) => r.method === "POST" && r.path === "/auth/logout-all")).toBe(true);
  });

  it("F-02: buat ulang backup code — konfirmasi, reautentikasi, kode tampil sekali lalu dibuang dari layar", async () => {
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Backup code");
    expect(within(card).getByText("Sisa 10 dari 10 backup code.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Buat ulang backup code" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Buat ulang backup code/ });
    await user.click(within(confirm).getByLabelText("Saya memahami backup code lama tidak berlaku lagi."));
    await user.click(within(confirm).getByRole("button", { name: "Buat kode baru" }));
    await confirmReauth(user);
    const dialog = await screen.findByRole("dialog", { name: "Backup code baru" });
    const codes = within(within(dialog).getByRole("list", { name: "Daftar backup code" })).getAllByRole("listitem");
    expect(codes).toHaveLength(10);
    expect(accountRequests.find((r) => r.path === "/admin/auth/backup-codes")?.reauth).toBe(true);
    // Kode lama (dipakai uji login) tidak berlaku lagi.
    const done = within(dialog).getByRole("button", { name: "Selesai" });
    expect(done).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Saya sudah menyimpan backup code di tempat yang aman."));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Backup code baru" })).toBeNull());
    expect(screen.queryByRole("list", { name: "Daftar backup code" })).toBeNull();
  });

  it("F-02: sisa backup code sedikit menampilkan saran buat ulang", async () => {
    mockConsumeBackupCodes(8);
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Backup code");
    expect(within(card).getByText("Sisa 2 dari 10 backup code.")).toBeInTheDocument();
    expect(within(card).getByRole("note")).toHaveTextContent("Backup code hampir habis");
  });

  it("keadaan galat: daftar perangkat gagal dimuat dapat dicoba lagi", async () => {
    mockAccount.failNextSessions(500);
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Perangkat yang masuk");
    expect(await within(card).findByText("Data gagal dimuat")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Coba lagi" }));
    expect(await within(card).findByText("Firefox di Ubuntu")).toBeInTheDocument();
  });

  it("paging kursor daftar perangkat", async () => {
    mockAccount.addSessions(25);
    const user = userEvent.setup();
    await openAccount(user);
    const card = await section("Perangkat yang masuk");
    await within(card).findByText("Firefox di Ubuntu");
    await user.click(within(card).getByRole("button", { name: "Halaman berikutnya" }));
    expect(await within(card).findByText("Peramban 25")).toBeInTheDocument();
    expect(within(card).queryByText("Perangkat ini")).toBeNull();
  });
});
