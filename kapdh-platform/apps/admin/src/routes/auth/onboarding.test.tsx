import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setAccessToken } from "../../api/client";
import { MOCK_CREDENTIALS } from "../../api/mocks";
import {
  invitationRequests,
  MOCK_EXPIRED_INVITE_TOKEN,
  MOCK_INVITE_TOKEN,
  MOCK_TOTP_SECRET,
  mockInvitations,
} from "../../api/mocks/invitations";
import { renderApp, signIn, type User } from "../../test/utils";
import { groupSecret } from "./EnrollPage";
import { parseInviteToken } from "./InvitePage";

const STRONG_PASSWORD = "Admin#Baru2026";

async function openInvite(token = MOCK_INVITE_TOKEN) {
  const app = renderApp(`/invite#t=${token}`);
  await screen.findByRole("heading", { level: 1, name: "Undangan admin" });
  return app;
}

async function acceptInvite(user: User) {
  await screen.findByRole("heading", { name: "Siti Rahmawati" });
  await user.type(screen.getByLabelText(/^Sandi baru/), STRONG_PASSWORD);
  await user.type(screen.getByLabelText(/^Ulangi sandi baru/), STRONG_PASSWORD);
  await user.click(screen.getByRole("button", { name: "Simpan sandi dan lanjutkan" }));
  await screen.findByRole("heading", { level: 1, name: "Daftarkan autentikator" });
  await screen.findByText(groupSecret(MOCK_TOTP_SECRET));
}

describe("undangan admin /invite#t= (F-16, kontrak admin-auth)", () => {
  it("parseInviteToken hanya menerima `t` 16..512 karakter dari fragmen", () => {
    expect(parseInviteToken(`#t=${MOCK_INVITE_TOKEN}`)).toBe(MOCK_INVITE_TOKEN);
    expect(parseInviteToken(`t=${MOCK_INVITE_TOKEN}&x=1`)).toBe(MOCK_INVITE_TOKEN);
    expect(parseInviteToken("t=pendek")).toBeNull();
    expect(parseInviteToken("")).toBeNull();
  });

  it("F-16: token dibaca dari fragmen, fragmen dihapus dari bilah alamat, token hanya dikirim di body", async () => {
    const { router } = await openInvite();
    expect(await screen.findByRole("heading", { name: "Siti Rahmawati" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    expect(router.state.location.href).not.toContain(MOCK_INVITE_TOKEN);
    expect(router.state.location.pathname).toBe("/invite");
    const preview = invitationRequests.find((r) => r.path === "/admin/auth/invitations/preview");
    expect(preview?.bodyKeys).toEqual(["invite_token"]);
    expect(preview?.query).toBe("");
    expect(preview?.path).not.toContain(MOCK_INVITE_TOKEN);
    // Pratinjau: peran, pengundang dan izin berlabel Bahasa Indonesia.
    expect(screen.getByText("si***@kapdh.test")).toBeInTheDocument();
    expect(screen.getByText("Fikri")).toBeInTheDocument();
    const perms = screen.getByRole("list", { name: "Izin undangan" });
    expect(within(perms).getByText("Menyetujui atau menolak pembayaran")).toBeInTheDocument();
  });

  it("F-16: tautan tanpa token menampilkan petunjuk tautan tidak lengkap tanpa memanggil API", async () => {
    renderApp("/invite");
    expect(await screen.findByText("Tautan undangan tidak lengkap")).toBeInTheDocument();
    expect(invitationRequests).toHaveLength(0);
  });

  it("F-16: undangan kedaluwarsa/terpakai (410 OTP_EXPIRED) menyarankan undangan baru", async () => {
    await openInvite(MOCK_EXPIRED_INVITE_TOKEN);
    expect(await screen.findByText("Undangan tidak berlaku")).toBeInTheDocument();
    expect(screen.getByText(/Minta undangan baru ke Super Admin/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Sandi baru/)).toBeNull();
  });

  it("PRD 2.5: syarat sandi dihitung dalam BYTE UTF-8 dan sandi lemah ditolak sebelum dikirim", async () => {
    const user = userEvent.setup();
    await openInvite();
    await screen.findByRole("heading", { name: "Siti Rahmawati" });
    const password = screen.getByLabelText(/^Sandi baru/);
    // 39 karakter tetapi 74 byte (é = 2 byte): melampaui 72 byte.
    const multibyte = `Aa1!${"é".repeat(35)}`;
    await user.click(password);
    await user.paste(multibyte);
    const rules = screen.getByRole("list", { name: "Syarat sandi" });
    expect(within(rules).getByText(/terpakai 74 byte/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Ulangi sandi baru/), "x");
    await user.click(screen.getByRole("button", { name: "Simpan sandi dan lanjutkan" }));
    await waitFor(() => expect(password).toHaveAccessibleDescription(/maksimal 72 byte/));
    expect(invitationRequests.some((r) => r.path === "/admin/auth/invitations/accept")).toBe(false);
  });

  it("F-02, F-16, PRD 8.2: undangan → sandi → QR + secret → kode salah → kode benar → backup code sekali → dashboard", async () => {
    const user = userEvent.setup();
    const { router } = await openInvite();
    await acceptInvite(user);
    expect(router.state.location.pathname).toBe("/login/enroll");
    // Secret ditampilkan berkelompok sebagai alternatif teks QR (N-11), beserta batas 30 menit.
    expect(screen.getByText("siti.rahmawati@kapdh.test")).toBeInTheDocument();
    expect(screen.getByText(/Selesaikan sebelum/)).toBeInTheDocument();
    const enroll = invitationRequests.find((r) => r.path === "/admin/auth/totp/enroll");
    expect(enroll?.bodyKeys).toEqual(["mfa_token"]);

    const code = screen.getByLabelText(/^Kode autentikator/);
    await user.type(code, "000000");
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan aktifkan akun" }));
    await waitFor(() => expect(code).toHaveAccessibleDescription(/salah\. Sisa percobaan 4\./));
    expect(code).toHaveValue("");

    await user.type(code, MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan aktifkan akun" }));
    const list = await screen.findByRole("list", { name: "Daftar backup code" });
    const codes = within(list).getAllByRole("listitem");
    expect(codes).toHaveLength(10);
    const first = /[A-Z2-7]{5}-[A-Z2-7]{5}/.exec(codes[0]?.textContent ?? "")?.[0];
    expect(first).toBeTruthy();
    // Lanjut hanya setelah admin menyatakan sudah menyimpan backup code.
    const done = screen.getByRole("button", { name: "Masuk ke Dashboard" });
    expect(done).toBeDisabled();
    await user.click(screen.getByLabelText("Saya sudah menyimpan backup code di tempat yang aman."));
    await user.click(done);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/Masuk sebagai/)).toHaveTextContent("Masuk sebagai Siti Rahmawati (Admin)");
    // Menu mengikuti izin undangan (AC F15-1).
    const nav = screen.getByRole("navigation", { name: "Menu admin" });
    expect(within(nav).queryByRole("link", { name: /Manajemen Admin/ })).toBeNull();
    expect(within(nav).getByRole("link", { name: /Verifikasi Pembayaran/ })).toBeInTheDocument();
    // Backup code tidak tersimpan di mana pun setelah layar ditutup.
    expect(screen.queryByRole("list", { name: "Daftar backup code" })).toBeNull();
    const stored = [window.localStorage, window.sessionStorage].flatMap((s) =>
      Object.keys(s).map((k) => `${k}=${s.getItem(k) ?? ""}`),
    );
    expect(stored.some((entry) => entry.includes(first!) || entry.includes(MOCK_TOTP_SECRET))).toBe(false);
  });

  it("AC F02-2: token pendaftaran kedaluwarsa (401) meminta undangan ulang, bukan login", async () => {
    const user = userEvent.setup();
    await openInvite();
    await acceptInvite(user);
    mockInvitations.expireEnrollment();
    await user.type(screen.getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan aktifkan akun" }));
    expect(
      await screen.findByText("Waktu pendaftaran habis atau undangan tidak berlaku"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Minta undangan ulang ke Super Admin/)).toBeInTheDocument();
  });

  it("AC F02-2, PRD 4.5: membatalkan aktivasi wajib dikonfirmasi karena token pendaftaran tidak dapat diterbitkan ulang", async () => {
    const user = userEvent.setup();
    const { router } = await openInvite();
    await acceptInvite(user);
    expect(screen.queryByRole("button", { name: /kembali ke halaman masuk/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Batalkan aktivasi" }));
    let dialog = await screen.findByRole("alertdialog", { name: /Batalkan aktivasi akun admin/ });
    expect(within(dialog).getByText(/Super Admin KAPDH perlu mengirim undangan ulang/)).toBeInTheDocument();
    // Fokus awal pada tombol aman; memilih lanjut menjaga token pendaftaran tetap di memori.
    expect(within(dialog).getByRole("button", { name: "Lanjutkan aktivasi" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Lanjutkan aktivasi" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(router.state.location.pathname).toBe("/login/enroll");
    expect(screen.getByText(groupSecret(MOCK_TOTP_SECRET))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Batalkan aktivasi" }));
    dialog = await screen.findByRole("alertdialog", { name: /Batalkan aktivasi akun admin/ });
    const confirm = within(dialog).getByRole("button", { name: "Ya, batalkan aktivasi" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/memerlukan undangan baru dari Super Admin/));
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    // Token sudah dibuang: /login/enroll tidak dapat dibuka lagi.
    await router.navigate({ to: "/login/enroll" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("AC F02-2: memuat ulang/menutup tab selama pendaftaran dan saat backup code tampil meminta konfirmasi peramban", async () => {
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const user = userEvent.setup();
    await openInvite();
    expect(unload()).toBe(false);
    await acceptInvite(user);
    expect(unload()).toBe(true);
    await user.type(screen.getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan aktifkan akun" }));
    await screen.findByRole("list", { name: "Daftar backup code" });
    expect(unload()).toBe(true);
    await user.click(screen.getByLabelText("Saya sudah menyimpan backup code di tempat yang aman."));
    await user.click(screen.getByRole("button", { name: "Masuk ke Dashboard" }));
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    expect(unload()).toBe(false);
  });

  it("PRD 4.5: konfirmasi yang hasilnya hilang lalu diulang (403 aktivasi selesai) mengarahkan ke masuk", async () => {
    const user = userEvent.setup();
    const { router } = await openInvite();
    await acceptInvite(user);
    mockInvitations.completeActivationElsewhere();
    await user.type(screen.getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Konfirmasi dan aktifkan akun" }));
    expect(await screen.findByText("Aktivasi sudah selesai")).toBeInTheDocument();
    expect(screen.getByText(/buat ulang di halaman Akun/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Masuk sekarang" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("RATE_LIMITED saat menerima undangan ditampilkan dengan waktu tunggu", async () => {
    const user = userEvent.setup();
    await openInvite();
    await screen.findByRole("heading", { name: "Siti Rahmawati" });
    mockInvitations.rateLimitNext();
    await user.type(screen.getByLabelText(/^Sandi baru/), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/^Ulangi sandi baru/), STRONG_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Simpan sandi dan lanjutkan" }));
    expect(await screen.findByText(/Coba lagi dalam 60 detik/)).toBeInTheDocument();
  });

  it("admin yang sedang masuk diminta keluar dulu sebelum menerima undangan identitas lain", async () => {
    const user = userEvent.setup();
    const first = renderApp("/login");
    await signIn(user);
    first.unmount();
    setAccessToken(null); // tab baru: sesi dipulihkan dari cookie refresh
    const app = renderApp(`/invite#t=${MOCK_INVITE_TOKEN}`);
    expect(await screen.findByText(/Anda sedang masuk sebagai/)).toBeInTheDocument();
    expect(invitationRequests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keluar lalu lanjutkan undangan" }));
    expect(await screen.findByRole("heading", { name: "Siti Rahmawati" })).toBeInTheDocument();
    expect(app.router.state.location.hash).toBe("");
  });
});

describe("/login/enroll hanya dengan token pendaftaran (AC F02-2)", () => {
  it("tanpa token pendaftaran diarahkan ke halaman masuk", async () => {
    const { router } = renderApp("/login/enroll");
    expect(await screen.findByRole("heading", { name: "Selamat Datang Kembali!" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("token tahap sandi (login) tidak membuka pendaftaran: diarahkan ke /login/mfa", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), MOCK_CREDENTIALS.email);
    await user.type(screen.getByLabelText(/^Kata sandi/), MOCK_CREDENTIALS.password);
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    await screen.findByLabelText(/^Kode autentikator/);
    await router.navigate({ to: "/login/enroll" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login/mfa"));
  });

  it("backup code berbentuk XXXXX-XXXXX (dengan tanda hubung) diterima di layar MFA", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    const code = `${MOCK_CREDENTIALS.backupCode.slice(0, 5)}-${MOCK_CREDENTIALS.backupCode.slice(5)}`;
    expect(await signIn(user, { backup: true, code })).toBeInTheDocument();
  });
});
