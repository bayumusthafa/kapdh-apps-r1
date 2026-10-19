import { PERMISSION_VALUES } from "@kapdh/contracts";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { MOCK_CREDENTIALS, mockAuth } from "../../api/mocks";
import { MOCK_MEMBER, memberRequests, mockMembers, skillId } from "../../api/mocks/members";
import { findToast, renderApp, signIn, signInViaApi, type User } from "../../test/utils";
import { latestCohort } from "./labels";
import { forgetMembersSearch } from "./listMemory";
import { isPreconditionFailure } from "./queries";

/**
 * Manajemen Users di web admin (F-15, F-16, AC F05-6, F10-4, F12-3..F12-5, F15-1, F15-4, F16-4) terhadap server
 * tiruan src/api/mocks/members.ts. Bukti mock bukan bukti AC sisi server (PRD 7.3); uji ini membuktikan perilaku
 * UI: data yang dikirim, konfirmasi, penyaringan izin dan penanganan konflik.
 */

/**
 * Potongan kode area dimuat lazy dan server tiruan menjawab lewat debounce/refetch; saat seluruh suite berjalan
 * paralel di mesin build, 1 detik bawaan Testing Library tidak selalu cukup.
 */
configure({ asyncUtilTimeout: 5_000 });

// Setiap kasus mulai dari daftar tanpa pencarian/filter yang diingat kasus sebelumnya.
beforeEach(() => forgetMembersSearch());

async function open(user: User, path: string, heading: string | RegExp) {
  renderApp(path);
  await signIn(user);
  return screen.findByRole("heading", { level: 1, name: heading });
}

const listRequests = () => memberRequests.filter((r) => r.method === "GET" && r.path === "/admin/members");

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

describe("daftar anggota (F-15, guideline hal. 16; server tiruan)", () => {
  it("F-15: total alumni terdaftar, kartu guideline dan paging kursor server", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    expect(await screen.findByText("33 total alumni terdaftar")).toBeInTheDocument();
    await screen.findByText("Menampilkan 24 dari 33");
    const hasan = card("Hasan Basri");
    expect(within(hasan).getByText("hasan.basri@alumni.test")).toBeInTheDocument();
    expect(within(hasan).getByText("Dumai")).toBeInTheDocument();
    expect(within(hasan).getByText("05.03.01.93")).toBeInTheDocument();
    expect(within(hasan).getByText("KTA Aktif")).toBeInTheDocument();
    // Alumni yang tertaut ke identitas admin diberi label "Admin" (F-16).
    expect(within(hasan).getByText("Admin")).toBeInTheDocument();
    expect(within(hasan).getByRole("link", { name: "Informasi Pengguna Hasan Basri" })).toBeInTheDocument();
    // Tidak ada tombol hapus: penghapusan akun hanya lewat alur akun anggota (F-14).
    expect(within(hasan).queryByRole("button", { name: /Hapus/ })).toBeNull();
    // Status tidak hanya warna: label teks untuk status lain juga tampil.
    expect(within(card("Rizky Pratama")).getByText("Dibatasi")).toBeInTheDocument();
    expect(within(card("Fatimah Zahra")).getByText("Belum bernomor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Halaman berikutnya" }));
    expect(await screen.findByText("Menampilkan 25–33 dari 33")).toBeInTheDocument();
    expect(listRequests().at(-1)?.query.cursor).toBeTruthy();
    expect(listRequests().at(-1)?.query.limit).toBe("24");
  });

  it("F-15: filter status dan angkatan dikirim ke server; total mengikuti filter dan tersimpan di URL", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("group", { name: "Filter anggota" });
    await user.selectOptions(
      within(panel).getByRole("combobox", { name: "Status keanggotaan" }),
      "suspended",
    );
    expect(await screen.findByText("2 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(card("Rizky Pratama")).toBeInTheDocument();
    expect(card("Dewi Lestari")).toBeInTheDocument();
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Angkatan" }), "22");
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(listRequests().at(-1)?.query).toMatchObject({ effective_status: "suspended", cohort: "22" });
    expect(screen.getByRole("button", { name: "Filter (2 aktif)" })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Reset filter" }));
    expect(await screen.findByText("33 total alumni terdaftar")).toBeInTheDocument();
    expect(listRequests().at(-1)?.query).not.toHaveProperty("effective_status");
  });

  it("F-15, F-10: filter profesi dan keahlian memakai master (termasuk nonaktif) dan kota persis", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    const panel = screen.getByRole("group", { name: "Filter anggota" });
    const profession = within(panel).getByRole("combobox", { name: "Profesi" });
    await waitFor(() => expect(profession).toBeEnabled());
    // Master nonaktif tetap dapat dipakai sebagai filter (kontrak adminListMembers).
    expect(
      within(profession).getByRole("option", { name: "Petani/Peternak/Nelayan (nonaktif)" }),
    ).toBeInTheDocument();
    await user.selectOptions(profession, "Petani/Peternak/Nelayan (nonaktif)");
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(card("Hendra Gunawan")).toBeInTheDocument();
    await user.selectOptions(profession, "Semua profesi");
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Keahlian" }), "Pemrograman");
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(listRequests().at(-1)?.query.skill_id).toBe(skillId("Pemrograman"));
    expect(card("Fikri Ramadhan")).toBeInTheDocument();
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Keahlian" }), "Semua keahlian");
    await user.type(within(panel).getByRole("searchbox", { name: "Kota domisili" }), "Bengkalis");
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(card("Ridho")).toBeInTheDocument();
    expect(listRequests().at(-1)?.query.city).toBe("Bengkalis");
  });

  it("F-15: pencarian nomor KTA di-debounce dan dikirim sebagai q", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    const before = listRequests().length;
    await user.type(screen.getByRole("searchbox", { name: "Cari alumni" }), "12.02");
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(card("Umar Faruq")).toBeInTheDocument();
    expect(
      listRequests()
        .slice(before)
        .map((r) => r.query.q),
    ).toEqual(["12.02"]);
  });

  it("F-15: daftar kosong menawarkan menghapus pencarian dan filter", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    await user.type(screen.getByRole("searchbox", { name: "Cari alumni" }), "tidak ada nama ini");
    expect(await screen.findByText("Tidak ada alumni yang cocok")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hapus pencarian dan filter" }));
    expect(await screen.findByText("33 total alumni terdaftar")).toBeInTheDocument();
  });

  it("AC F15-1: tanpa members.read daftar ditolak; tanpa members.manage/master.manage tombol terkait tidak tampil", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["members.manage"] });
    const user = userEvent.setup();
    const first = renderApp("/members");
    await signIn(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Akses ditolak");
    expect(listRequests()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    await screen.findByLabelText(/^Kata sandi/);
    first.unmount();

    mockAuth.setAdmin({ role: "admin", permissions: ["members.read"] });
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    expect(screen.queryByRole("link", { name: /Manajemen Skill & Profesi/ })).toBeNull();
    expect(within(card("Umar Faruq")).queryByRole("button", { name: /Ubah data/ })).toBeNull();
  });

  it("F-15: ikon ubah pada kartu membuka formulir ubah di halaman detail", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    await user.click(within(card("Umar Faruq")).getByRole("button", { name: "Ubah data Umar Faruq" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah data anggota" });
    expect(within(dialog).getByRole("textbox", { name: /Nama lengkap/ })).toHaveValue("Umar Faruq");
    expect(screen.getByRole("heading", { level: 1, name: "Umar Faruq" })).toBeInTheDocument();
  });

  it("F-15: kembali dari detail dan halaman master lewat breadcrumb mempertahankan pencarian dan filter daftar", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/members?status=suspended&cohort=22");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Manajemen Users" });
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    const crumbs = () => within(screen.getByRole("navigation", { name: "Breadcrumb" }));

    await user.click(
      within(card("Rizky Pratama")).getByRole("link", { name: "Informasi Pengguna Rizky Pratama" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Rizky Pratama" });
    await user.click(crumbs().getByRole("link", { name: "Manajemen Users" }));
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ status: "suspended", cohort: 22 });
    expect(listRequests().at(-1)?.query).toMatchObject({ effective_status: "suspended", cohort: "22" });

    await user.click(screen.getByRole("link", { name: /Manajemen Skill & Profesi/ }));
    await screen.findByRole("heading", { level: 1, name: "Manajemen Skill & Profesi" });
    await user.click(crumbs().getByRole("link", { name: "Manajemen Users" }));
    expect(await screen.findByText("1 alumni sesuai pencarian dan filter")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ status: "suspended", cohort: 22 });
  });

  it("PRD 2.3, F-14: ikon ubah tidak tampil untuk akun yang sedang dihapus; pada akun tertaut admin sendiri alasannya diumumkan", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/members?q=Yusuf");
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Manajemen Users" });
    const yusuf = await screen.findByRole("article", { name: "Yusuf Hamdani" });
    expect(within(yusuf).queryByRole("button", { name: /Ubah data/ })).toBeNull();
    expect(within(yusuf).getByRole("link", { name: "Informasi Pengguna Yusuf Hamdani" })).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Cari alumni" });
    await user.clear(search);
    await user.type(search, "Fikri");
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "Fikri" }));
    const fikri = await screen.findByRole("article", { name: "Fikri Ramadhan" });
    // Ringkasan daftar tidak memuat id admin tertaut; konflik kepentingan diperiksa di detail.
    await user.click(within(fikri).getByRole("button", { name: "Ubah data Fikri Ramadhan" }));
    await screen.findByRole("heading", { level: 1, name: "Fikri Ramadhan" });
    const notice = await screen.findByText(
      /Formulir ubah data tidak dibuka: akun alumni ini tertaut ke akun admin Anda/,
    );
    const region = notice.closest("[role=status]") as HTMLElement;
    await waitFor(() => expect(region).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Ubah data anggota" })).toBeNull();
    expect(router.state.location.search).toEqual({});

    await user.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", {
        name: "Manajemen Users",
      }),
    );
    await screen.findByRole("article", { name: "Fikri Ramadhan" });
    expect(router.state.location.search).toEqual({ q: "Fikri" });
  });

  it("PRD 3.5: angkatan terbaru mengikuti tahun berjalan WIB seperti server, pada filter dan formulir ubah", async () => {
    // Rumus server (MembershipKernel.latestCohort): tahun Jakarta - 1996; angkatan 30 lulus 2026.
    expect(latestCohort(new Date("2026-10-12T11:00:00Z"))).toBe(30);
    expect(latestCohort(new Date("2026-12-31T16:30:00Z"))).toBe(30); // 31 Des 2026 23.30 WIB
    expect(latestCohort(new Date("2026-12-31T17:30:00Z"))).toBe(31); // 1 Jan 2027 00.30 WIB
    const max = latestCohort();

    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    await user.click(screen.getByRole("button", { name: "Filter" }));
    const cohort = within(screen.getByRole("group", { name: "Filter anggota" })).getByRole("combobox", {
      name: "Angkatan",
    });
    expect(within(cohort).getByRole("option", { name: `Angkatan ${max}` })).toBeInTheDocument();
    expect(within(cohort).queryByRole("option", { name: `Angkatan ${max + 1}` })).toBeNull();

    await user.click(within(card("Umar Faruq")).getByRole("button", { name: "Ubah data Umar Faruq" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah data anggota" });
    const input = within(dialog).getByRole("spinbutton", { name: /Angkatan/ });
    await user.clear(input);
    await user.type(input, String(max + 1));
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Koreksi angkatan");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAccessibleDescription(new RegExp(`Angkatan berupa angka 1 sampai ${max}\\.`));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(memberRequests.some((r) => r.method === "PATCH")).toBe(false);
  });
});

describe("keadaan layar anggota (PRD 4.5)", () => {
  it("PRD 4.5: daftar menampilkan status memuat lalu kartu alumni", async () => {
    const release = mockMembers.hold();
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    expect(await screen.findByText("Memuat daftar alumni...")).toBeInTheDocument();
    expect(screen.getByText("Memuat jumlah alumni...")).toBeInTheDocument();
    release();
    expect(await screen.findByText("Menampilkan 24 dari 33")).toBeInTheDocument();
  });

  it("PRD 4.5: galat server pada daftar ditampilkan dengan tombol coba lagi", async () => {
    mockMembers.fail("GET", /^\/admin\/members$/);
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    expect(await screen.findByText("Data gagal dimuat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByText("Menampilkan 24 dari 33")).toBeInTheDocument();
  });

  it("PRD 4.5: galat server pada detail ditampilkan dengan tombol coba lagi", async () => {
    mockMembers.fail("GET", /^\/admin\/members\/[^/]+$/);
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Informasi Pengguna");
    expect(await screen.findByText("Data gagal dimuat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Umar Faruq" })).toBeInTheDocument();
  });

  it("PRD 4.5: refetch latar detail gagal → halaman dan formulir yang sedang diisi dipertahankan, galat sebaris dengan coba lagi", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.hasan, "Hasan Basri");
    const reason = within(dialog).getByRole("textbox", { name: /Alasan perubahan/ });
    await user.type(reason, "Draf alasan perubahan");
    mockMembers.fail("GET", /^\/admin\/members\/[^/]+$/, 503, 1);
    // Kembali online memicu refetch latar (useApiQuery); refetch ini gagal.
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByText(/Data anggota terbaru gagal dimuat/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Ubah data anggota" })).toBe(dialog);
    expect(reason).toHaveValue("Draf alasan perubahan");
    expect(screen.getByRole("heading", { level: 1, name: "Hasan Basri" })).toBeInTheDocument();
    expect(screen.queryByText("Data gagal dimuat")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(screen.queryByText(/Data anggota terbaru gagal dimuat/)).toBeNull());
    expect(screen.getByRole("region", { name: "Profil alumni" })).toHaveTextContent("Dumai");
  });

  it("PRD 4.5: refetch latar daftar gagal → kartu tetap tampil dengan galat sebaris dan coba lagi", async () => {
    const user = userEvent.setup();
    await open(user, "/members", "Manajemen Users");
    await screen.findByText("Menampilkan 24 dari 33");
    mockMembers.fail("GET", /^\/admin\/members$/, 503, 1);
    window.dispatchEvent(new Event("online"));
    expect(await screen.findByText(/Daftar alumni terbaru gagal dimuat/)).toBeInTheDocument();
    expect(card("Hasan Basri")).toBeInTheDocument();
    expect(screen.getByText("Menampilkan 24 dari 33")).toBeInTheDocument();
    expect(screen.queryByText("Data gagal dimuat")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(screen.queryByText(/Daftar alumni terbaru gagal dimuat/)).toBeNull());
    expect(card("Hasan Basri")).toBeInTheDocument();
  });
});

describe("detail anggota (F-15, F-10; server tiruan)", () => {
  it("F-10: kontak tampil terlepas dari privasi dengan catatan administratif; periode dan pembayaran tampil", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.hasan}`, "Hasan Basri");
    const contact = screen.getByRole("region", { name: "Kontak (administratif)" });
    expect(within(contact).getByText(/tercatat di audit/)).toBeInTheDocument();
    expect(within(contact).getByText("+62 812-7000-1002")).toBeInTheDocument();
    expect(within(contact).getAllByText("Disembunyikan dari anggota lain").length).toBeGreaterThan(0);
    expect(within(contact).getByRole("link", { name: "Instagram hasan.uji (tab baru)" })).toHaveAttribute(
      "href",
      "https://www.instagram.com/hasan.uji",
    );
    expect(
      within(contact).getByRole("link", { name: /^LinkedIn https:\/\/www\.linkedin\.com/ }),
    ).toHaveAttribute("href", "https://www.linkedin.com/in/hasan-uji");
    const membership = screen.getByRole("region", { name: "Keanggotaan" });
    expect(within(membership).getByRole("table", { name: "Periode keanggotaan" })).toHaveTextContent(
      "Aktivasi",
    );
    const payments = screen.getByRole("region", { name: "Pembayaran terbaru" });
    expect(within(payments).getByText("Pendaftaran Rp60.000")).toBeInTheDocument();
    expect(within(payments).getByText("Disetujui")).toBeInTheDocument();
    // Pembukaan detail adalah GET biasa (server mencatat audit member.viewed).
    expect(
      memberRequests.some((r) => r.method === "GET" && r.path === `/admin/members/${MOCK_MEMBER.hasan}`),
    ).toBe(true);
  });

  it("AC F10-4: profesi dan keahlian master nonaktif tampil sebagai label historis", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.hendra}`, "Hendra Gunawan");
    const profile = screen.getByRole("region", { name: "Profil alumni" });
    expect(within(profile).getByText("Petani/Peternak/Nelayan")).toBeInTheDocument();
    expect(within(profile).getByText("Master nonaktif")).toBeInTheDocument();
  });

  it("PRD 2.3, AC F15-1: tanpa payments/events/moderation.read ringkasan disaring dan alasan suspend disembunyikan", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["members.read"] });
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.rizky}`, "Rizky Pratama");
    expect(screen.getByRole("region", { name: "Pembayaran terbaru" })).toHaveTextContent(
      "hanya untuk admin dengan izin melihat pembayaran",
    );
    expect(screen.getByRole("region", { name: "Tiket event terbaru" })).toHaveTextContent(
      "hanya untuk pengelola event",
    );
    expect(screen.getByRole("region", { name: "Moderasi" })).toHaveTextContent("moderation.read");
    const suspension = screen.getByRole("region", { name: "Akun dibatasi" });
    expect(suspension).toHaveTextContent("Alasan hanya untuk pemegang izin moderasi");
    expect(suspension).not.toHaveTextContent("Promosi berulang");
    expect(suspension).toHaveTextContent("Akun Anda dibatasi karena melanggar pedoman komunitas.");
    // Tanpa izin tindakan: tidak ada tombol ubah, batasi, cabut atau reset.
    for (const name of ["Ubah data", "Batasi akun", "Cabut pembatasan", "Reset sandi"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    // Histori tanpa moderation.read: entri warn tidak dikirim, filter warn tidak ditawarkan.
    const history = screen.getByRole("region", { name: "Histori keanggotaan dan moderasi" });
    const timeline = await within(history).findByRole("list", { name: "Histori keanggotaan" });
    expect(within(timeline).getByText("Dibatasi (suspend)")).toBeInTheDocument();
    expect(within(timeline).queryByText("Peringatan moderasi")).toBeNull();
    expect(within(timeline).getByText(/Alasan hanya untuk pemegang izin moderasi/)).toBeInTheDocument();
    expect(within(history).queryByRole("option", { name: "Peringatan moderasi" })).toBeNull();
  });

  it("PRD 4.2: histori keanggotaan dan moderasi lengkap untuk pemegang moderation.read, dapat difilter", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.rizky}`, "Rizky Pratama");
    const history = screen.getByRole("region", { name: "Histori keanggotaan dan moderasi" });
    const timeline = await within(history).findByRole("list", { name: "Histori keanggotaan" });
    expect(within(timeline).getByText("Peringatan moderasi")).toBeInTheDocument();
    expect(within(timeline).getByText("Aktivasi keanggotaan")).toBeInTheDocument();
    expect(within(timeline).getByText(/Alasan: Promosi produk di grup alumni/)).toBeInTheDocument();
    await user.selectOptions(within(history).getByRole("combobox", { name: "Jenis histori" }), "warn");
    await waitFor(() =>
      expect(within(history).getByRole("list", { name: "Histori keanggotaan" })).not.toHaveTextContent(
        "Aktivasi keanggotaan",
      ),
    );
    expect(memberRequests.at(-1)?.query.kind).toBe("warn");
  });

  it("PRD 2.3: akun alumni yang tertaut ke admin sendiri tidak dapat diubah, dibatasi atau di-reset", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.fikriRamadhan}`, "Fikri Ramadhan");
    expect(
      screen.getAllByRole("note").some((n) => n.textContent?.includes("tertaut ke akun admin Anda")),
    ).toBe(true);
    for (const name of ["Ubah data", "Batasi akun", "Reset sandi"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("region", { name: "Akun admin tertaut" })).toHaveTextContent("Akun Anda");
  });

  it("F-14: akun yang sedang dihapus tidak dapat diubah atau dibatasi", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.yusuf}`, "Yusuf Hamdani");
    expect(screen.getAllByRole("note").some((n) => n.textContent?.includes("proses penghapusan"))).toBe(true);
    for (const name of ["Ubah data", "Batasi akun", "Reset sandi"])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("PRD 4.5: anggota yang tidak ada menampilkan Data tidak ditemukan", async () => {
    const user = userEvent.setup();
    renderApp("/members/0199e000-0000-7000-8000-ffffffffffff");
    await signIn(user);
    expect(await screen.findByText("Data tidak ditemukan")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kembali ke daftar alumni" })).toBeInTheDocument();
  });
});

async function openEdit(user: User, userId: string, name: string) {
  await open(user, `/members/${userId}`, name);
  await user.click(screen.getByRole("button", { name: "Ubah data" }));
  return screen.findByRole("dialog", { name: "Ubah data anggota" });
}

const patches = () => memberRequests.filter((r) => r.method === "PATCH");

describe("ubah data dan koreksi identitas (AC F05-6, F15-4)", () => {
  it("AC F05-6: koreksi kelas keluar 12.02.01.7 menjadi 12.01.01.7 dengan alasan dan konfirmasi; nomor dari server", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.umar, "Umar Faruq");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /Kelas keluar/ }), "6");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    // Alasan wajib (pra-validasi klien) sebelum konfirmasi.
    const reason = within(dialog).getByRole("textbox", { name: /Alasan perubahan/ });
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(/minimal 3 karakter/);
    expect(patches()).toHaveLength(0);

    await user.type(reason, "Koreksi kelas keluar sesuai ijazah Aliyah");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Simpan koreksi identitas/ });
    expect(within(confirm).getByText("Kelas 5 (2 Aliyah)", { exact: false })).toBeInTheDocument();
    expect(within(confirm).getByText("Kelas 6 (3 Aliyah)")).toBeInTheDocument();
    expect(within(confirm).getByText("12.02.01.7")).toBeInTheDocument();
    const save = within(confirm).getByRole("button", { name: "Simpan koreksi" });
    expect(save).toBeDisabled();
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(save);

    const status = await screen.findByText(/Data Umar Faruq disimpan/);
    const region = status.closest("[role=status]") as HTMLElement;
    expect(region).toHaveTextContent("12.02.01.7 → 12.01.01.7");
    expect(region).toHaveTextContent("nomor urut tetap");
    // Hanya field yang berubah + alasan; nomor anggota tidak pernah dikirim klien.
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toEqual({
      reason: "Koreksi kelas keluar sesuai ijazah Aliyah",
      class_out: 6,
    });
    expect(patches()[0]?.ifMatch).toBe("1");
    expect(mockMembers.get(MOCK_MEMBER.umar)?.member_number).toBe("12.01.01.7");
    expect(screen.queryByRole("dialog", { name: "Ubah data anggota" })).toBeNull();
    // Histori mencatat koreksi nomor lama → baru.
    const history = screen.getByRole("region", { name: "Histori keanggotaan dan moderasi" });
    expect(await within(history).findByText(/Nomor 12\.02\.01\.7 → 12\.01\.01\.7/)).toBeInTheDocument();
  });

  it("F-15: perubahan non-identitas langsung disimpan tanpa dialog koreksi; kosong menjadi null", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.hasan, "Hasan Basri");
    const city = within(dialog).getByRole("textbox", { name: /Kota domisili/ });
    await user.clear(city);
    await user.type(city, "Pekanbaru");
    await user.clear(within(dialog).getByRole("textbox", { name: "Telepon" }));
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Pindah domisili");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    expect(await screen.findByText("Data Hasan Basri disimpan.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(patches()[0]?.body).toEqual({ reason: "Pindah domisili", city: "Pekanbaru", phone: null });
  });

  it("PRD 4.5: tanpa perubahan atau tautan sosial tidak aman ditolak sebelum dikirim", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.hasan, "Hasan Basri");
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Cek data");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Belum ada perubahan");
    const x = within(dialog).getByRole("textbox", { name: "X" });
    await user.type(x, "javascript:alert(1)");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    await waitFor(() => expect(x).toHaveAttribute("aria-invalid", "true"));
    expect(x).toHaveAccessibleDescription(/https:\/\//);
    expect(patches()).toHaveLength(0);
  });

  it("AC F10-4: profesi/keahlian nonaktif hanya tersedia bila sudah dipakai anggota", async () => {
    const user = userEvent.setup();
    let dialog = await openEdit(user, MOCK_MEMBER.hendra, "Hendra Gunawan");
    const profession = within(dialog).getByRole("combobox", { name: "Profesi" });
    await waitFor(() =>
      expect(
        within(profession).getByRole("option", { name: "Petani/Peternak/Nelayan (nonaktif)" }),
      ).toBeInTheDocument(),
    );
    expect(profession).toHaveDisplayValue("Petani/Peternak/Nelayan (nonaktif)");
    // Master nonaktif lain tidak dapat dipilih baru.
    expect(within(profession).queryByRole("option", { name: /Pensiunan/ })).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /Kuliner/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog", { name: "Ubah data anggota" })).toBeNull();

    await user.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", {
        name: "Manajemen Users",
      }),
    );
    await screen.findByText("Menampilkan 24 dari 33");
    await user.click(
      within(card("Siti Rahmawati")).getByRole("button", { name: "Ubah data Siti Rahmawati" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Ubah data anggota" });
    expect(await within(dialog).findByRole("checkbox", { name: "Kuliner (nonaktif)" })).toBeChecked();
  });

  it("AC F15-4: konflik versi → data terbaru dimuat, Simpan nonaktif sampai formulir dimuat ulang", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.hasan, "Hasan Basri");
    const city = within(dialog).getByRole("textbox", { name: /Kota domisili/ });
    await user.clear(city);
    await user.type(city, "Pekanbaru");
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Pindah domisili");
    mockMembers.touchByOtherAdmin(MOCK_MEMBER.hasan, { city: "Bengkalis" });
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    expect(await findToast("error", "sudah diubah admin lain")).toBeInTheDocument();
    const banner = await within(dialog).findByRole("alert");
    expect(banner).toHaveTextContent("tidak tertimpa");
    const save = within(dialog).getByRole("button", { name: "Simpan perubahan" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    // Halaman sudah menampilkan data terbaru dari `current` 409.
    expect(screen.getByRole("region", { name: "Profil alumni" })).toHaveTextContent("Bengkalis");
    expect(mockMembers.raw(MOCK_MEMBER.hasan)?.city).toBe("Bengkalis");

    await user.click(within(dialog).getByRole("button", { name: "Muat data terbaru" }));
    expect(within(dialog).getByRole("textbox", { name: /Kota domisili/ })).toHaveValue("Bengkalis");
    await user.clear(within(dialog).getByRole("textbox", { name: /Kota domisili/ }));
    await user.type(within(dialog).getByRole("textbox", { name: /Kota domisili/ }), "Pekanbaru");
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Pindah domisili");
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));
    expect(await screen.findByText("Data Hasan Basri disimpan.")).toBeInTheDocument();
    expect(patches().map((p) => p.ifMatch)).toEqual(["1", "2"]);
  });

  it("PRD 4.5, F-14: anggota mulai menghapus akun saat formulir ubah terbuka → 400 galat akar; formulir ditutup, data terbaru dimuat dan diumumkan", async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, MOCK_MEMBER.hasan, "Hasan Basri");
    const city = within(dialog).getByRole("textbox", { name: /Kota domisili/ });
    await user.clear(city);
    await user.type(city, "Pekanbaru");
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan perubahan/ }), "Pindah domisili");
    // users.status berubah tanpa menaikkan alumni.version: If-Match tetap cocok, server menolak prasyarat.
    mockMembers.requestDeletion(MOCK_MEMBER.hasan);
    await user.click(within(dialog).getByRole("button", { name: "Simpan perubahan" }));

    const notice = await screen.findByText(
      /Akun sedang dalam proses penghapusan dan tidak dapat diubah\. Tindakan tidak dijalankan/,
    );
    await waitFor(() => expect(notice.closest("[role=status]")).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Ubah data anggota" })).toBeNull();
    expect(
      await screen.findByText(/sedang dalam proses penghapusan atas permintaan anggota/),
    ).toBeInTheDocument();
    for (const name of ["Ubah data", "Batasi akun", "Reset sandi"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.ifMatch).toBe("1");
    expect(mockMembers.raw(MOCK_MEMBER.hasan)?.city).toBe("Dumai");
  });
});

async function confirmWithAck(dialog: HTMLElement, user: User, label: string) {
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(within(dialog).getByRole("button", { name: label }));
}

describe("batasi dan cabut pembatasan (PRD 4.2, AC F12-3..F12-5)", () => {
  it("AC F12-3, F12-4: batasi akun wajib alasan internal, pesan anggota dan konfirmasi dua langkah", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    await user.click(screen.getByRole("button", { name: "Batasi akun" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batasi akun Umar Faruq/ });
    const confirm = within(dialog).getByRole("button", { name: "Batasi akun" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await confirmWithAck(dialog, user, "Batasi akun");
    expect(within(dialog).getByRole("textbox", { name: /Alasan internal/ })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(memberRequests.some((r) => r.path.endsWith("/suspend"))).toBe(false);

    await user.type(
      within(dialog).getByRole("textbox", { name: /Alasan internal/ }),
      "Penipuan di grup alumni",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: /Pesan untuk anggota/ }),
      "Akun Anda dibatasi karena melanggar pedoman.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Batasi akun" }));

    expect(await screen.findByText(/Umar Faruq dibatasi\. Seluruh sesi anggota dicabut/)).toBeInTheDocument();
    const request = memberRequests.find((r) => r.path.endsWith("/suspend"));
    expect(request?.body).toEqual({
      reason: "Penipuan di grup alumni",
      member_message: "Akun Anda dibatasi karena melanggar pedoman.",
      confirm: true,
    });
    expect(request?.ifMatch).toBe("1");
    expect(request?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockMembers.get(MOCK_MEMBER.umar)?.effective_status).toBe("suspended");
    // Tanggal periode tidak berubah (PRD 4.2); tombol berganti menjadi Cabut pembatasan.
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.expires_at).toBe("2027-03-02T03:00:00.000Z");
    expect(await screen.findByRole("button", { name: "Cabut pembatasan" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Akun dibatasi" })).toHaveTextContent(
      "Penipuan di grup alumni",
    );
  });

  it("AC F12-5: cabut pembatasan anggota yang masa aktifnya habis menjadi KTA Kedaluwarsa, bukan otomatis aktif", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.dewi}`, "Dewi Lestari");
    await user.click(screen.getByRole("button", { name: "Cabut pembatasan" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Cabut pembatasan Dewi Lestari/ });
    await user.type(
      within(dialog).getByRole("textbox", { name: /Alasan pencabutan/ }),
      "Masa pembatasan selesai",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cabut pembatasan" }));
    expect(await screen.findByText(/Status keanggotaan sekarang: KTA Kedaluwarsa/)).toBeInTheDocument();
    const request = memberRequests.find((r) => r.path.endsWith("/unsuspend"));
    // Pesan opsional kosong tidak dikirim; server memakai teks baku.
    expect(request?.body).toEqual({ reason: "Masa pembatasan selesai", confirm: true });
    expect(mockMembers.get(MOCK_MEMBER.dewi)?.effective_status).toBe("expired");
    expect(screen.queryByRole("region", { name: "Akun dibatasi" })).toBeNull();
  });

  it("AC F12-5: cabut pembatasan dengan masa aktif berjalan menjadi KTA Aktif dan menutup banding aktif", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.rizky}`, "Rizky Pratama");
    expect(screen.getByRole("region", { name: "Moderasi" })).toHaveTextContent("Laporan aktif2");
    await user.click(screen.getByRole("button", { name: "Cabut pembatasan" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Cabut pembatasan Rizky Pratama/ });
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan pencabutan/ }), "Banding dikabulkan");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Pesan untuk anggota/ }),
      "Silakan kembali aktif.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cabut pembatasan" }));
    expect(await screen.findByText(/Status keanggotaan sekarang: KTA Aktif/)).toBeInTheDocument();
    expect(memberRequests.find((r) => r.path.endsWith("/unsuspend"))?.body).toMatchObject({
      member_message: "Silakan kembali aktif.",
    });
    expect(mockMembers.raw(MOCK_MEMBER.rizky)?.openAppeals).toBe(0);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Moderasi" })).toHaveTextContent("Laporan aktif1"),
    );
  });

  it("AC F15-4: data berubah sebelum batasi disimpan → 409, data terbaru dimuat dan diumumkan", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    mockMembers.touchByOtherAdmin(MOCK_MEMBER.umar, { city: "Kampar" });
    await user.click(screen.getByRole("button", { name: "Batasi akun" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batasi akun Umar Faruq/ });
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan internal/ }), "Penipuan");
    await user.type(within(dialog).getByRole("textbox", { name: /Pesan untuk anggota/ }), "Akun dibatasi.");
    await confirmWithAck(dialog, user, "Batasi akun");
    expect(await screen.findByText(/Data anggota berubah sebelum tindakan disimpan/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mockMembers.get(MOCK_MEMBER.umar)?.effective_status).toBe("verified");
    expect(screen.getByRole("region", { name: "Profil alumni" })).toHaveTextContent("Kampar");
  });

  it("PRD 4.5, AC F12-3: anggota mulai menghapus akun sebelum batasi disimpan → prasyarat 400 bentuk server; dialog ditutup, data terbaru dimuat dan diumumkan", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    const detailGets = () =>
      memberRequests.filter((r) => r.method === "GET" && r.path === `/admin/members/${MOCK_MEMBER.umar}`)
        .length;
    // users.status berubah tanpa menaikkan alumni.version: If-Match tetap cocok.
    mockMembers.requestDeletion(MOCK_MEMBER.umar);
    const before = detailGets();
    await user.click(screen.getByRole("button", { name: "Batasi akun" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batasi akun Umar Faruq/ });
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan internal/ }), "Penipuan");
    await user.type(within(dialog).getByRole("textbox", { name: /Pesan untuk anggota/ }), "Akun dibatasi.");
    await confirmWithAck(dialog, user, "Batasi akun");

    const notice = await screen.findByText(
      /Akun sedang dalam proses penghapusan dan tidak dapat dibatasi\. Tindakan tidak dijalankan/,
    );
    await waitFor(() => expect(notice.closest("[role=status]")).toHaveFocus());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before));
    expect(
      await screen.findByText(/sedang dalam proses penghapusan atas permintaan anggota/),
    ).toBeInTheDocument();
    for (const name of ["Ubah data", "Batasi akun", "Reset sandi"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(memberRequests.find((r) => r.path.endsWith("/suspend"))?.ifMatch).toBe("1");
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.suspension).toBeNull();
  });

  it("PRD 4.5: server tiruan menjawab prasyarat suspend/unsuspend dengan bentuk MembershipKernel; galat isian bukan prasyarat", async () => {
    await signInViaApi();
    const header = (version: string) => ({ "If-Match": version, "Idempotency-Key": crypto.randomUUID() });
    const notSuspended = await api.POST("/admin/members/{userId}/unsuspend", {
      params: { path: { userId: MOCK_MEMBER.umar }, header: header("1") },
      body: { reason: "Uji prasyarat", confirm: true },
    });
    expect(notSuspended.response.status).toBe(400);
    expect(notSuspended.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Anggota tidak sedang dibatasi.",
      current: { suspended_at: null, account_status: "active", version: "1" },
    });
    expect(notSuspended.error).not.toHaveProperty("field_errors");
    expect(isPreconditionFailure(ApiError.fromResponse(notSuspended.error, 400))).toBe(true);

    const alreadySuspended = await api.POST("/admin/members/{userId}/suspend", {
      params: { path: { userId: MOCK_MEMBER.rizky }, header: header("1") },
      body: { reason: "Uji prasyarat", member_message: "Pesan uji.", confirm: true },
    });
    expect(alreadySuspended.response.status).toBe(400);
    expect(alreadySuspended.error).toMatchObject({
      message: "Anggota sudah dalam status dibatasi.",
      current: { account_status: "active", version: "1" },
    });
    expect(isPreconditionFailure(ApiError.fromResponse(alreadySuspended.error, 400))).toBe(true);

    const invalid = await api.POST("/admin/members/{userId}/suspend", {
      params: { path: { userId: MOCK_MEMBER.umar }, header: header("1") },
      body: { reason: " ", member_message: "Pesan uji.", confirm: true },
    });
    expect(invalid.response.status).toBe(400);
    expect(isPreconditionFailure(ApiError.fromResponse(invalid.error, 400))).toBe(false);
    // Galat akar `_` (ubah data akun yang sedang dihapus) juga prasyarat; konflik versi bukan.
    const root = new ApiError({
      code: "VALIDATION_ERROR",
      status: 400,
      message: "x",
      fieldErrors: { _: ["x"] },
    });
    expect(isPreconditionFailure(root)).toBe(true);
    expect(isPreconditionFailure(new ApiError({ code: "VERSION_CONFLICT", status: 409, message: "x" }))).toBe(
      false,
    );
  });

  it("PRD 2.3: tanpa moderation.resolve tombol batasi tidak tampil walau dapat mengubah data", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["members.read", "members.manage", "moderation.read"] });
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    expect(screen.getByRole("button", { name: "Ubah data" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batasi akun" })).toBeNull();
  });
});

describe("pemulihan sandi alumni oleh Super Admin (F-16, AC F16-4)", () => {
  it("AC F16-4: reautentikasi lalu inisiasi; sesi dicabut dan kode hanya ke email terverifikasi", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    await user.click(screen.getByRole("button", { name: "Reset sandi" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Mulai pemulihan sandi Umar Faruq/ });
    expect(dialog).toHaveTextContent("umar.faruq@alumni.test");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Alasan/ }),
      "Permintaan anggota via kanal bantuan",
    );
    await confirmWithAck(dialog, user, "Mulai pemulihan");

    // Reautentikasi wajib sebelum permintaan dikirim (X-Reauth-Token, ARCHITECTURE §4.3).
    const reauth = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
    expect(reauth).toHaveTextContent("Memulai pemulihan sandi Umar Faruq");
    expect(memberRequests.some((r) => r.path.endsWith("/password-reset"))).toBe(false);
    await user.type(within(reauth).getByLabelText(/^Sandi/), MOCK_CREDENTIALS.password);
    await user.type(within(reauth).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
    await user.click(within(reauth).getByRole("button", { name: "Konfirmasi" }));

    const done = await screen.findByText(/Pemulihan sandi Umar Faruq dimulai\. 2 sesi anggota dicabut/);
    expect(done).toHaveTextContent("Kode dan sandi tidak pernah ditampilkan ke pengurus");
    const request = memberRequests.find((r) => r.path.endsWith("/password-reset"));
    expect(request?.body).toEqual({ reason: "Permintaan anggota via kanal bantuan", confirm: true });
    expect(request?.reauthToken).toMatch(/^mock-reauth-/);
    expect(request?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.sessions).toBe(0);
  });

  it("AC F16-4: admin dengan semua izin tetapi bukan Super Admin tidak dapat memulai pemulihan", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: [...PERMISSION_VALUES] });
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    expect(screen.getByRole("button", { name: "Batasi akun" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset sandi" })).toBeNull();
  });

  it("AC F16-4: akun yang belum aktif (pending_otp) tidak ditawari pemulihan", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.fatimah}`, "Fatimah Zahra");
    expect(screen.queryByRole("button", { name: "Reset sandi" })).toBeNull();
  });

  it("AC F16-4, PRD 4.5: akun mulai dihapus sebelum pemulihan dikirim → 400 galat akar; dialog ditutup, data terbaru dimuat dan tombol reset hilang", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    await user.click(screen.getByRole("button", { name: "Reset sandi" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Mulai pemulihan sandi Umar Faruq/ });
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan/ }), "Permintaan anggota");
    mockMembers.requestDeletion(MOCK_MEMBER.umar);
    await confirmWithAck(dialog, user, "Mulai pemulihan");
    await reauthenticate(user);

    const notice = await screen.findByText(
      /Pemulihan sandi hanya untuk akun aktif yang emailnya sudah terverifikasi\. Tindakan tidak dijalankan/,
    );
    await waitFor(() => expect(notice.closest("[role=status]")).toHaveFocus());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset sandi" })).toBeNull());
    expect(
      await screen.findByText(/sedang dalam proses penghapusan atas permintaan anggota/),
    ).toBeInTheDocument();
    // Tidak ada sesi yang dicabut.
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.sessions).toBe(2);
  });

  it("PRD 2.5, AC F16-4: batas OTP email anggota (429 RATE_LIMITED) → hitung mundur, tombol mulai nonaktif sampai waktu tunggu habis", async () => {
    const user = userEvent.setup();
    await open(user, `/members/${MOCK_MEMBER.umar}`, "Umar Faruq");
    await user.click(screen.getByRole("button", { name: "Reset sandi" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Mulai pemulihan sandi Umar Faruq/ });
    await user.type(within(dialog).getByRole("textbox", { name: /Alasan/ }), "Permintaan anggota");
    await confirmWithAck(dialog, user, "Mulai pemulihan");
    // Lima kode sudah dikirim ke email anggota dalam satu jam terakhir (mis. lewat Lupa sandi mandiri).
    mockMembers.exhaustOtpSends(MOCK_MEMBER.umar, 4);
    await reauthenticate(user);

    const message = await within(dialog).findByText(/Terlalu banyak permintaan kode untuk akun ini/);
    expect(message).toHaveAttribute("role", "alert");
    expect(message).toHaveTextContent(/Pemulihan dapat dicoba lagi dalam \d detik\./);
    expect(within(dialog).getByText(/Sisa waktu tunggu/)).toBeInTheDocument();
    const start = within(dialog).getByRole("button", { name: "Mulai pemulihan" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    const resets = () => memberRequests.filter((r) => r.path.endsWith("/password-reset")).length;
    expect(resets()).toBe(1);
    // Selama hitung mundur klik tidak meminta reautentikasi maupun mengirim permintaan baru.
    await user.click(start);
    expect(screen.queryByRole("dialog", { name: "Konfirmasi identitas" })).toBeNull();
    expect(resets()).toBe(1);
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.sessions).toBe(2);

    // Waktu tunggu habis: tombol aktif lagi dan pemulihan berhasil dengan Idempotency-Key niat yang sama.
    await waitFor(() => expect(start).not.toHaveAttribute("aria-disabled"), { timeout: 8_000 });
    expect(within(dialog).queryByText(/Sisa waktu tunggu/)).toBeNull();
    await user.click(start);
    await reauthenticate(user);
    expect(await screen.findByText(/Pemulihan sandi Umar Faruq dimulai/)).toBeInTheDocument();
    const sent = memberRequests.filter((r) => r.path.endsWith("/password-reset"));
    expect(sent).toHaveLength(2);
    expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
    expect(mockMembers.raw(MOCK_MEMBER.umar)?.sessions).toBe(0);
  });
});

async function reauthenticate(user: User) {
  const reauth = await screen.findByRole("dialog", { name: "Konfirmasi identitas" });
  await user.type(within(reauth).getByLabelText(/^Sandi/), MOCK_CREDENTIALS.password);
  await user.type(within(reauth).getByLabelText(/^Kode autentikator/), MOCK_CREDENTIALS.totp);
  await user.click(within(reauth).getByRole("button", { name: "Konfirmasi" }));
}
