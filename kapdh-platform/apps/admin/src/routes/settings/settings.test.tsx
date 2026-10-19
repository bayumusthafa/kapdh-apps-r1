import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import { mockSettings, settingsRequests } from "../../api/mocks/settings";
import { expectNoReauthDialog, openPage, section } from "../../test/governance";
import { findToast, renderApp, signIn } from "../../test/utils";
import { compareSemver } from "./SettingsPage";

const puts = () => settingsRequests.filter((r) => r.method === "PUT");

describe("pengaturan aplikasi (F-15, AC F15-3, F15-4; server tiruan)", () => {
  it("compareSemver membandingkan MAJOR.MINOR.PATCH secara numerik", () => {
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.9.0", "1.0.0")).toBeLessThan(0);
  });

  it("AC F15-3, ADR-025: ubah versi minimum tanpa reautentikasi, memakai If-Match versi kunci dan mencatat versi baru", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Versi aplikasi minimum");
    expect(within(card).getByText(/Versi 1 \| diubah/)).toBeInTheDocument();
    const android = within(card).getByLabelText(/^Versi minimum Android/);
    await user.clear(android);
    await user.type(android, "1.1.0");
    await user.click(within(card).getByRole("button", { name: "Simpan versi minimum" }));
    expect(await findToast("success", "Versi aplikasi minimum disimpan.")).toBeInTheDocument();
    expectNoReauthDialog();
    expect(within(card).getByText(/Versi 2 \| diubah .* oleh Fikri/)).toBeInTheDocument();
    const sent = puts().at(-1);
    expect(sent).toMatchObject({ path: "/admin/settings/min-app-version", ifMatch: "1", reauth: false });
    expect(sent?.body).toEqual({ android: "1.1.0", ios: "1.0.0" });
  });

  it("PRD 8.4: versi minimum iOS tidak dapat dinaikkan sebelum tautan App Store terisi", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Versi aplikasi minimum");
    const ios = within(card).getByLabelText(/^Versi minimum iOS/);
    expect(ios).toHaveAccessibleDescription(/Tautan toko belum diisi/);
    await user.clear(ios);
    await user.type(ios, "2.0.0");
    await user.click(within(card).getByRole("button", { name: "Simpan versi minimum" }));
    await waitFor(() => expect(ios).toHaveAccessibleDescription(/Isi tautan toko iOS/));
    expect(screen.queryByRole("dialog", { name: /Konfirmasi identitas/ })).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("AC F15-4: versi kunci berubah oleh admin lain → 409, isian tidak menimpa diam-diam, UI menawarkan muat ulang", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Kontak dukungan");
    mockSettings.changeElsewhere("support", { email: "info@kapdh.or.id" });
    const email = within(card).getByLabelText(/^Email dukungan/);
    await user.clear(email);
    await user.type(email, "pengurus@kapdh.or.id");
    await user.click(within(card).getByRole("button", { name: "Simpan kontak dukungan" }));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("sudah diubah Hasan Basri (versi 2)");
    // Tidak ada percobaan kedua otomatis dengan versi baru (tidak menimpa diam-diam).
    expect(puts()).toHaveLength(1);
    expect(within(card).getByRole("button", { name: "Simpan kontak dukungan" })).toBeDisabled();
    expect(email).toHaveValue("pengurus@kapdh.or.id");
    await user.click(within(card).getByRole("button", { name: "Muat versi terbaru" }));
    expect(email).toHaveValue("info@kapdh.or.id");
    expect(within(card).getByText(/Versi 2 \| diubah .* oleh Hasan Basri/)).toBeInTheDocument();
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("PRD 4.5: mengaktifkan pemeliharaan wajib pesan dan konfirmasi eksplisit, tanpa reautentikasi", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Mode pemeliharaan");
    expect(within(card).getByText("Layanan normal")).toBeInTheDocument();
    await user.click(within(card).getByRole("switch", { name: "Aktifkan mode pemeliharaan" }));
    await user.click(within(card).getByRole("button", { name: "Simpan mode pemeliharaan" }));
    const message = within(card).getByLabelText(/^Pesan untuk pengguna/);
    await waitFor(() => expect(message).toHaveAccessibleDescription(/Pesan wajib diisi/));
    await user.type(message, "Pemeliharaan server 30 menit. Coba lagi pukul 23.00 WIB.");
    await user.click(within(card).getByRole("button", { name: "Simpan mode pemeliharaan" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Aktifkan mode pemeliharaan/ });
    await user.click(within(confirm).getByRole("button", { name: "Aktifkan pemeliharaan" }));
    expect(await findToast("success", "Mode pemeliharaan diaktifkan.")).toBeInTheDocument();
    expectNoReauthDialog();
    expect(within(card).getByText("Pemeliharaan aktif")).toBeInTheDocument();
    expect(puts().at(-1)).toMatchObject({ path: "/admin/settings/maintenance", ifMatch: "1", reauth: false });
    expect(puts().at(-1)?.body).toMatchObject({ active: true, until: null });
  });

  it("D13: menyembunyikan instruksi iuran di iOS mengirim daftar platform dan catatan audit", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Instruksi bayar iuran per platform");
    await user.click(within(card).getByLabelText("iOS"));
    await user.type(within(card).getByLabelText(/^Catatan perubahan/), "Review App Store 3.1.1");
    await user.click(within(card).getByRole("button", { name: "Simpan instruksi iuran" }));
    expect(await within(card).findByText("Saat ini: disembunyikan di iOS.")).toBeInTheDocument();
    expect(puts().at(-1)?.body).toEqual({
      dues_hidden_platforms: ["ios"],
      reason: "Review App Store 3.1.1",
    });
  });

  it("validasi klien: WhatsApp wajib format E.164 dan tautan toko hanya domain resmi", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const support = await section("Kontak dukungan");
    const wa = within(support).getByLabelText(/^WhatsApp pengurus/);
    await user.type(wa, "081234");
    await user.click(within(support).getByRole("button", { name: "Simpan kontak dukungan" }));
    await waitFor(() => expect(wa).toHaveAccessibleDescription(/format internasional/));
    const store = await section("Tautan toko aplikasi");
    const ios = within(store).getByLabelText(/^App Store/);
    await user.type(ios, "https://contoh.com/app");
    await user.click(within(store).getByRole("button", { name: "Simpan tautan toko" }));
    await waitFor(() => expect(ios).toHaveAccessibleDescription(/apps\.apple\.com/));
    expect(puts()).toHaveLength(0);
  });

  it("keputusan PO 2026-10-15 (ADR-025): tautan toko dan kontak dukungan disimpan tanpa dialog Konfirmasi identitas dan tanpa X-Reauth-Token", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const store = await section("Tautan toko aplikasi");
    await user.type(within(store).getByLabelText(/^App Store/), "https://apps.apple.com/id/app/kapdh/id123");
    await user.click(within(store).getByRole("button", { name: "Simpan tautan toko" }));
    expect(await findToast("success", "Tautan toko aplikasi disimpan.")).toBeInTheDocument();
    expectNoReauthDialog();
    const support = await section("Kontak dukungan");
    const email = within(support).getByLabelText(/^Email dukungan/);
    await user.clear(email);
    await user.type(email, "pengurus@kapdh.or.id");
    await user.click(within(support).getByRole("button", { name: "Simpan kontak dukungan" }));
    expect(await findToast("success", "Kontak dukungan disimpan.")).toBeInTheDocument();
    expectNoReauthDialog();
    expect(puts().map((r) => ({ path: r.path, ifMatch: r.ifMatch, reauth: r.reauth }))).toEqual([
      { path: "/admin/settings/store-links", ifMatch: "1", reauth: false },
      { path: "/admin/settings/support", ifMatch: "1", reauth: false },
    ]);
  });

  it("kebijakan PRD hanya dapat dibaca (tanpa isian)", async () => {
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    const card = await section("Kebijakan yang disahkan PRD");
    expect(within(card).getByText("12 bulan kalender per iuran")).toBeInTheDocument();
    expect(within(card).getByText("Sampai H-3")).toBeInTheDocument();
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("keadaan galat: GET /admin/settings gagal menampilkan galat dengan coba lagi", async () => {
    mockSettings.failNextGet(500);
    const user = userEvent.setup();
    await openPage(user, "/settings", "Pengaturan");
    expect(await screen.findByText("Pengaturan gagal dimuat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await section("Mode pemeliharaan")).toBeInTheDocument();
  });

  it("AC F15-1: admin tanpa settings.manage ditolak di rute dan tidak memanggil API pengaturan", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    renderApp("/settings");
    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(settingsRequests).toHaveLength(0);
  });
});
