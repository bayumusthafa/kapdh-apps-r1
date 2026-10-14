import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import { eventRequests, MOCK_EVENT_CATEGORY_IDS, MOCK_EVENT_IDS, mockEvents } from "../../api/mocks/events";
import { findToast, renderApp, signIn, type User } from "../../test/utils";
import { eventKeys } from "./api";
import { COVER_UPLOAD_WAIT } from "./EventForm";

/**
 * Manajemen Event & Tiket (F-09, F-15, guideline p14) pada server tiruan. Mock bukan bukti AC sisi server
 * (PRD 7.3); uji ini membuktikan perilaku UI: tabel, filter, formulir, konflik versi, kuota, pembatalan, tiket.
 */
const REUNI = "Reuni Akbar KAPDH 2026";
/** Pencarian di-debounce lalu data dimuat ulang; saat suite berjalan paralel, bawaan 1 detik bisa terlalu ketat. */
const SEARCH_WAIT = 4_000;
const MANCING = "Mancing Bareng Alumni";

const requests = (method: string, path: string) =>
  eventRequests.filter((r) => r.method === method && r.path === path);

async function open(user: User, path: string, heading: string) {
  renderApp(path);
  await signIn(user);
  // Potongan kode area dimuat lazy: beri waktu lebih dari bawaan 1 detik saat suite berjalan paralel.
  return screen.findByRole("heading", { level: 1, name: heading }, { timeout: 5_000 });
}

function rowOf(table: HTMLElement, name: string | RegExp): HTMLElement {
  return within(table).getByRole("rowheader", { name }).closest("tr")!;
}

describe("tabel Event dan Tiket (guideline p14, F-15; server tiruan)", () => {
  it("F-15 (guideline p14): menampilkan kolom, kategori, periode daftar dan sisa tiket menurut proyeksi kursi", async () => {
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    const table = await screen.findByRole("table", { name: "Daftar event" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Nama Event",
      "Gambar",
      "Kategori",
      "Lokasi",
      "Buka Daftar",
      "Tutup Daftar",
      "Total Tiket",
      "Sisa Tiket",
      "Kelola",
    ]);
    expect(screen.getByText("Menampilkan 6 dari 6")).toBeInTheDocument();
    const reuni = rowOf(table, new RegExp(REUNI));
    const detail = mockEvents.event(MOCK_EVENT_IDS.reuni)!;
    // Hold yang sudah lewat tidak dihitung (proyeksi baca tag Events).
    expect(within(reuni).getByText(detail.seats_available.toLocaleString("id-ID"))).toBeInTheDocument();
    expect(within(reuni).getByText(`Ditahan ${detail.held_quantity}`)).toBeInTheDocument();
    expect(within(reuni).getByText(`Terbayar ${detail.paid_quantity}`)).toBeInTheDocument();
    expect(within(reuni).getByText("1.000")).toBeInTheDocument();
    expect(within(reuni).getByText("Reuni")).toBeInTheDocument();
    expect(within(reuni).getByText("Pendaftaran dibuka")).toBeInTheDocument();
    // Event dibatalkan tidak menampilkan sisa kursi yang menyesatkan.
    expect(
      within(rowOf(table, /Pramuka Bersama/)).getByText("Dibatalkan", { selector: "span.text-text-muted" }),
    ).toBeInTheDocument();
    // Hari kemerdekaan dll: tombol cari, kategori dan buat event tersedia.
    expect(screen.getByRole("button", { name: "Manajemen Kategori" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Buat Event Baru/ })).toHaveAttribute("href", "/events/new");
  });

  it("AC F15-2: hapus dinonaktifkan untuk event yang sudah memiliki tiket; event tanpa tiket dapat dihapus", async () => {
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    const table = await screen.findByRole("table", { name: "Daftar event" });
    expect(
      within(rowOf(table, new RegExp(REUNI))).getByRole("button", {
        name: /^Hapus Reuni Akbar KAPDH 2026 tidak tersedia/,
      }),
    ).toBeDisabled();
    expect(
      within(rowOf(table, new RegExp(MANCING))).getByRole("button", { name: `Hapus ${MANCING}` }),
    ).toBeEnabled();
    // Event selesai/dibatalkan tidak dapat diubah.
    expect(
      within(rowOf(table, /Jalan Sehat Kemerdekaan/)).queryByRole("button", { name: /^Ubah/ }),
    ).toBeNull();
  });

  it("PRD 4.5: hapus event draf memerlukan konfirmasi dua langkah dan mengirim If-Match", async () => {
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    const table = await screen.findByRole("table", { name: "Daftar event" });
    await user.click(
      within(rowOf(table, new RegExp(MANCING))).getByRole("button", { name: `Hapus ${MANCING}` }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Hapus event\?/ });
    const confirm = within(dialog).getByRole("button", { name: "Hapus event" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    await user.click(within(dialog).getByRole("checkbox", { name: /Saya memahami event ini dihapus/ }));
    await user.click(confirm);
    await findToast("success", `Event "${MANCING}" dihapus.`);
    await waitFor(() => expect(screen.getByText("Menampilkan 5 dari 5")).toBeInTheDocument());
    expect(requests("DELETE", `/admin/events/${MOCK_EVENT_IDS.mancing}`)[0]?.ifMatch).toBe("1");
  });

  it("F-15: pencarian (debounce), filter status dan kategori serta urutan dikirim ke server", async () => {
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    await screen.findByText("Menampilkan 6 dari 6", {}, { timeout: SEARCH_WAIT });
    await user.type(screen.getByRole("searchbox", { name: "Cari event" }), "lubuk");
    await screen.findByText("Menampilkan 1 dari 1", {}, { timeout: SEARCH_WAIT });
    // Ketikan lambat dapat memicu debounce pada "lubu" (hasilnya sama); tunggu permintaan untuk kata kunci lengkap.
    await waitFor(() => expect(requests("GET", "/admin/events").at(-1)?.query).toMatchObject({ q: "lubuk" }));
    await user.clear(screen.getByRole("searchbox", { name: "Cari event" }));
    await screen.findByText("Menampilkan 6 dari 6", {}, { timeout: SEARCH_WAIT });
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "open");
    await screen.findByText("Menampilkan 2 dari 2", {}, { timeout: SEARCH_WAIT });
    await screen.findByRole("option", { name: "Seminar" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Kategori" }), "Seminar");
    await screen.findByText("Menampilkan 1 dari 1", {}, { timeout: SEARCH_WAIT });
    await user.selectOptions(screen.getByRole("combobox", { name: "Urutkan" }), "title_asc");
    await waitFor(() =>
      expect(requests("GET", "/admin/events").at(-1)?.query).toMatchObject({
        status: "open",
        category_id: "0199e100-0000-7000-8000-0000000000c2",
        sort: "title_asc",
      }),
    );
  });

  it("AC F15-1: admin tanpa events.manage tidak dapat membuka Event dan Tiket walau URL diketik langsung", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    const user = userEvent.setup();
    renderApp("/events");
    await signIn(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Akses ditolak");
    expect(requests("GET", "/admin/events")).toHaveLength(0);
  });
});

describe("buat event (F-15, kontrak adminCreateEvent)", () => {
  it("F-15, N-10, PRD 2.1: validasi klien, unggah cover, zona waktu event, lalu tersimpan sebagai draf dan membuka detail", async () => {
    const user = userEvent.setup();
    await open(user, "/events/new", "Buat Event Baru");
    await user.click(screen.getByRole("button", { name: "Simpan sebagai draf" }));
    expect(await screen.findByText("Nama event wajib diisi.")).toBeInTheDocument();
    expect(screen.getByText("Waktu mulai wajib diisi.")).toBeInTheDocument();
    expect(screen.getByText("Kuota wajib diisi.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nama event/)).toHaveFocus();
    expect(requests("POST", "/admin/events")).toHaveLength(0);

    await user.type(screen.getByLabelText(/^Nama event/), "  Bakti Sosial Alumni ");
    await screen.findByRole("option", { name: "Seminar" });
    // Kategori nonaktif tidak dapat dipilih untuk event baru.
    expect(screen.queryByRole("option", { name: /Kajian/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText(/^Kategori/), "Seminar");
    await user.type(screen.getByLabelText(/^Nama lokasi/), "Aula Pondok");
    await user.type(screen.getByLabelText(/^Tautan peta/), "http://maps.example.com/aula");
    await user.upload(
      screen.getByTestId("cover-input"),
      new File([new Uint8Array([137, 80, 78, 71])], "sampul.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("img", { name: "Pratinjau gambar cover event" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Mulai/), { target: { value: "2027-03-10T09:00" } });
    fireEvent.change(screen.getByLabelText(/^Selesai/), { target: { value: "2027-03-10T15:00" } });
    fireEvent.change(screen.getByLabelText(/^Buka daftar/), { target: { value: "2027-02-01T08:00" } });
    fireEvent.change(screen.getByLabelText(/^Tutup daftar/), { target: { value: "2027-03-09T23:59" } });
    // PRD 2.1: ganti zona ke WITA mempertahankan jam yang sudah diketik.
    await user.selectOptions(screen.getByLabelText(/^Zona waktu event/), "Asia/Makassar");
    expect(screen.getByLabelText(/^Mulai/)).toHaveValue("2027-03-10T09:00");
    expect(screen.getAllByText("WITA").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText(/^Harga tiket/), "60000");
    await user.type(screen.getByLabelText(/^Total tiket/), "150");
    await user.click(screen.getByRole("button", { name: "Simpan sebagai draf" }));
    expect(await screen.findByText("Tautan lokasi harus diawali https://.")).toBeInTheDocument();
    expect(requests("POST", "/admin/events")).toHaveLength(0);
    await user.clear(screen.getByLabelText(/^Tautan peta/));
    await user.type(screen.getByLabelText(/^Tautan peta/), "https://maps.example.com/aula");
    await user.click(screen.getByRole("button", { name: "Simpan sebagai draf" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Bakti Sosial Alumni" })).toBeInTheDocument();
    await findToast("success", "Event draf dibuat");
    expect(screen.getByText("Draf")).toBeInTheDocument();
    const post = requests("POST", "/admin/events")[0]!;
    expect(post.idempotencyKey).toBeTruthy();
    expect(post.body).toMatchObject({
      title: "Bakti Sosial Alumni",
      category_id: "0199e100-0000-7000-8000-0000000000c2",
      location_name: "Aula Pondok",
      location_url: "https://maps.example.com/aula",
      timezone: "Asia/Makassar",
      // 09.00 WITA = 01.00Z; dikirim ISO UTC (ARCHITECTURE §2.6).
      starts_at: "2027-03-10T01:00:00.000Z",
      ends_at: "2027-03-10T07:00:00.000Z",
      registration_closes_at: "2027-03-09T15:59:00.000Z",
      checkin_opens_at: null,
      checkin_closes_at: null,
      price: "60000.00",
      seats_total: 150,
    });
    expect(typeof post.body?.cover_file_id).toBe("string");
    // Draf: dapat diterbitkan atau dihapus, belum dapat dibatalkan.
    expect(screen.getByRole("button", { name: "Terbitkan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batalkan event" })).toBeNull();
  });

  it("D5: jendela check-in khusus wajib lengkap; event gratis dijelaskan langsung lunas (AC F09-3)", async () => {
    const user = userEvent.setup();
    await open(user, "/events/new", "Buat Event Baru");
    expect(screen.getByText(/Isi 0 untuk event gratis/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Atur jendela check-in sendiri" }));
    fireEvent.change(screen.getByLabelText(/^Buka check-in/), { target: { value: "2027-03-10T07:00" } });
    await user.click(screen.getByRole("button", { name: "Simpan sebagai draf" }));
    expect(await screen.findByText("Tutup check-in wajib diisi.")).toBeInTheDocument();
  });
});

describe("detail event (F-09, F-15)", () => {
  it("F-09, D5: ringkasan memakai zona event, jendela check-in bawaan D5, kursi dan statistik pendapatan", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}`, REUNI);
    expect(screen.getByText("Bawaan", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Ringkasan kursi" })).toHaveTextContent("Total tiket");
    const stats = await screen.findByText("Pendapatan kotor");
    const card = stats.closest("section")!;
    // 6 tiket lunas x Rp60.000 (Money string, tanpa floating point).
    expect(within(card).getAllByText("Rp360.000").length).toBe(2);
    expect(within(card).getByText("Menunggu verifikasi")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Peserta & Tiket/ })).toBeInTheDocument();
  });

  it("AC F09-6: tautan pemindai dari detail event membuka check-in dengan event tersebut terpilih", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}`, REUNI);
    await user.click(await screen.findByRole("link", { name: "Buka pemindai check-in" }));
    await screen.findByRole("heading", { level: 1, name: "Check-in Tiket" }, { timeout: 5_000 });
    expect(await screen.findByRole("radio", { name: new RegExp(REUNI) })).toBeChecked();
    await waitFor(() => expect(screen.getByLabelText(/^Kode tiket/)).toHaveFocus());
  });

  it("PRD 4.4, 4.5: terbitkan draf dengan konfirmasi, If-Match dan Idempotency-Key; status baru tampil", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.mancing}`, MANCING);
    await user.click(screen.getByRole("button", { name: "Terbitkan" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Terbitkan event?" });
    await user.click(within(dialog).getByRole("button", { name: "Terbitkan" }));
    await findToast("success", "Event diterbitkan");
    expect(await screen.findByRole("button", { name: "Tutup pendaftaran" })).toBeInTheDocument();
    expect(screen.getAllByText("Pendaftaran dibuka").length).toBeGreaterThan(0);
    const req = requests("POST", `/admin/events/${MOCK_EVENT_IDS.mancing}/status`)[0]!;
    expect(req.body).toEqual({ status: "open" });
    expect(req.ifMatch).toBe("1");
    expect(req.idempotencyKey).toBeTruthy();
  });

  it("AC F15-4: event diubah pengurus lain saat formulir terbuka; simpan ditolak dan UI menawarkan muat ulang", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=edit`, REUNI);
    const title = await screen.findByLabelText(/^Nama event/);
    await user.clear(title);
    await user.type(title, "Reuni Akbar 2026 (revisi)");
    mockEvents.editElsewhere(MOCK_EVENT_IDS.reuni, { title: "Reuni Akbar Nasional" });
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    const alert = await screen.findByText(/sudah diubah di tempat lain/);
    expect(alert.closest("[role=alert]")).toHaveFocus();
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)[0]).toMatchObject({
      ifMatch: "3",
      body: { title: "Reuni Akbar 2026 (revisi)" },
    });
    // Tidak menimpa diam-diam: simpan dikunci sampai versi terbaru dimuat.
    expect(screen.getByRole("button", { name: "Simpan perubahan" })).toHaveAttribute("aria-disabled", "true");
    expect(mockEvents.event(MOCK_EVENT_IDS.reuni)!.title).toBe("Reuni Akbar Nasional");
    await user.click(screen.getByRole("button", { name: "Muat versi terbaru" }));
    expect(screen.getByLabelText(/^Nama event/)).toHaveValue("Reuni Akbar Nasional");
    await user.type(screen.getByLabelText(/^Nama event/), " 2026");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    await findToast("success", "Perubahan event disimpan.");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Reuni Akbar Nasional 2026" }),
    ).toBeInTheDocument();
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)[1]?.ifMatch).toBe("4");
  });

  it("AC F15-2: kuota di bawah kursi ditahan + terbayar ditolak klien dan server; galat di isian kuota dengan batas terbaru", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=edit`, REUNI);
    const seats = await screen.findByLabelText(/^Total tiket/);
    const min = mockEvents.event(MOCK_EVENT_IDS.reuni)!.min_seats_total;
    // Pra-validasi klien memakai min_seats_total terbaca.
    await user.clear(seats);
    await user.type(seats, String(min - 1));
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    expect(
      await screen.findByText(`Kuota tidak boleh di bawah ${min} (kursi ditahan + terbayar).`),
    ).toBeInTheDocument();
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)).toHaveLength(0);
    // Sementara formulir terbuka, anggota menahan 3 kursi lagi: server menolak dengan batas terbaru.
    await user.clear(seats);
    await user.type(seats, String(min));
    mockEvents.addHolds(MOCK_EVENT_IDS.reuni, 3);
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    const latest = mockEvents.event(MOCK_EVENT_IDS.reuni)!;
    expect(
      await screen.findByText(
        `Kuota tidak boleh di bawah ${latest.min_seats_total} (kursi ditahan ${latest.held_quantity} + terbayar ${latest.paid_quantity}).`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Total tiket/)).toHaveFocus();
    expect(screen.getByLabelText(/^Total tiket/)).toHaveAttribute("aria-invalid", "true");
    expect(
      await screen.findByText(new RegExp(`Kuota minimal ${latest.min_seats_total}\\.`)),
    ).toBeInTheDocument();
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)[0]?.body).toEqual({ seats_total: min });
    // Reservasi anggota tidak menaikkan versi: tidak ada peringatan konflik palsu.
    expect(screen.queryByText(/sudah diubah di tempat lain/)).toBeNull();
  });

  it("PRD 4.4, AC F03-5: harga event bertiket dapat diubah (kontrak adminUpdateEvent) setelah konfirmasi bahwa tiket lama memakai harga saat dipesan", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=edit`, REUNI);
    const price = await screen.findByLabelText(/^Harga tiket/);
    expect(price).not.toHaveAttribute("readonly");
    expect(screen.getByText(/harga baru hanya berlaku untuk reservasi baru/)).toBeInTheDocument();
    await user.clear(price);
    await user.type(price, "75000");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Ubah harga tiket?" });
    expect(within(dialog).getByText(/dari Rp60\.000 menjadi Rp75\.000/)).toBeInTheDocument();
    expect(within(dialog).getByText(/tetap memakai harga saat dipesan/)).toBeInTheDocument();
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Simpan harga baru" }));
    await findToast("success", "Perubahan event disimpan.");
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)[0]?.body).toEqual({
      price: "75000.00",
    });
    expect(mockEvents.event(MOCK_EVENT_IDS.reuni)!.price).toBe("75000.00");
    // Pembatalan event menjelaskan refund per tiket sebesar total yang dibayar, bukan harga event saat ini.
    await user.click(await screen.findByRole("button", { name: "Batalkan event" }));
    const cancel = await screen.findByRole("alertdialog", { name: /Batalkan event\?/ });
    expect(
      within(cancel).getByText(/refund penuh sebesar total yang dibayar pemegangnya/),
    ).toBeInTheDocument();
    expect(within(cancel).queryByText(/Rp75\.000/)).toBeNull();
  });

  it("N-10, F-15: simpan ditahan selama gambar cover masih diunggah; setelah selesai cover ikut tersimpan", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=edit`, REUNI);
    await user.type(await screen.findByLabelText(/^Nama lokasi/), " Pekanbaru");
    const release = mockEvents.holdCoverUploads();
    await user.upload(
      screen.getByTestId("cover-input"),
      new File([new Uint8Array([137, 80, 78, 71])], "sampul.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("button", { name: /^Mengunggah/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    // Pesan dibacakan (role=alert) di dekat tombol simpan.
    expect(await screen.findByText(COVER_UPLOAD_WAIT)).toHaveAttribute("role", "alert");
    expect(requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)).toHaveLength(0);
    // Formulir tetap terbuka: unggahan tidak dibatalkan.
    expect(screen.getByLabelText(/^Nama lokasi/)).toHaveValue("Pondok Darel Hikmah Pekanbaru");

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Mengunggah/ })).toBeNull());
    await waitFor(() => expect(screen.queryByText(COVER_UPLOAD_WAIT)).toBeNull());
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    // Perubahan lokasi pada event bertiket diberitahukan kepada pemegang tiket (AC F13-6).
    await findToast("success", "Pemegang tiket diberi notifikasi perubahan jadwal atau lokasi.");
    const patch = requests("PATCH", `/admin/events/${MOCK_EVENT_IDS.reuni}`)[0]!;
    expect(patch.body).toMatchObject({ location_name: "Pondok Darel Hikmah Pekanbaru" });
    expect(typeof patch.body?.cover_file_id).toBe("string");
    expect(mockEvents.event(MOCK_EVENT_IDS.reuni)!.cover_file_id).toBe(patch.body?.cover_file_id);
  });

  it("PRD 4.5: muat ulang detail yang gagal tidak mengganti halaman; isian formulir ubah tetap ada", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderApp(`/events/${MOCK_EVENT_IDS.reuni}?tab=edit`);
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: REUNI }, { timeout: 5_000 });
    const title = await screen.findByLabelText(/^Nama event/);
    await user.clear(title);
    await user.type(title, "Reuni Akbar (draf revisi)");
    mockEvents.failDetailReads(1);
    await act(() => queryClient.invalidateQueries({ queryKey: eventKeys.detail(MOCK_EVENT_IDS.reuni) }));
    expect(await screen.findByText(/Data event terbaru gagal dimuat/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nama event/)).toHaveValue("Reuni Akbar (draf revisi)");
    await user.click(screen.getByRole("button", { name: "Coba lagi" }));
    await waitFor(() => expect(screen.queryByText(/Data event terbaru gagal dimuat/)).toBeNull());
    expect(screen.getByLabelText(/^Nama event/)).toHaveValue("Reuni Akbar (draf revisi)");
  });

  it("N-11: setelah terbitkan atau simpan perubahan, fokus pindah ke status event (tidak jatuh ke body)", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.mancing}`, MANCING);
    await user.click(screen.getByRole("button", { name: "Terbitkan" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Terbitkan event?" });
    await user.click(within(dialog).getByRole("button", { name: "Terbitkan" }));
    await findToast("success", "Event diterbitkan");
    const status = screen.getByTestId("event-status-line");
    await waitFor(() => expect(status).toHaveFocus());
    await waitFor(() => expect(status).toHaveTextContent("Pendaftaran dibuka"));
    expect(screen.queryByRole("button", { name: "Terbitkan" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Ubah" }));
    await user.type(await screen.findByLabelText(/^Nama event/), " Edisi 2");
    await user.click(screen.getByRole("button", { name: "Simpan perubahan" }));
    await findToast("success", "Perubahan event disimpan.");
    await waitFor(() => expect(screen.queryByLabelText(/^Nama event/)).toBeNull());
    expect(screen.getByTestId("event-status-line")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("AC F09-7: batalkan event dengan alasan; konfirmasi menjelaskan QR, notifikasi dan refund; ringkasan dampak tampil", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}`, REUNI);
    await user.click(screen.getByRole("button", { name: "Batalkan event" }));
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan event\?/ });
    expect(within(dialog).getByText(/QR seluruh tiket tidak berlaku lagi/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/refund penuh sebesar total yang dibayar pemegangnya.*7 hari kerja/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/tetap di antrean\s+verifikasi/)).toBeInTheDocument();
    expect(within(dialog).getByText(/tetap tersimpan sebagai riwayat/)).toBeInTheDocument();
    await within(dialog).findByText(/6 lunas, 2 masih ditahan/);
    const confirm = within(dialog).getByRole("button", { name: "Batalkan event" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /Saya memahami pembatalan/ }));
    await user.click(confirm);
    expect(await within(dialog).findByText("Alasan wajib diisi, minimal 3 karakter.")).toBeInTheDocument();
    expect(requests("POST", `/admin/events/${MOCK_EVENT_IDS.reuni}/cancel`)).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/^Alasan pembatalan/), "  Lokasi terdampak banjir ");
    await user.click(confirm);

    const notice = await screen.findByText("Event dibatalkan. Notifikasi peserta dijadwalkan.");
    const box = notice.closest("[role=status]")!;
    expect(box).toHaveTextContent("8 tiket aktif dibatalkan.");
    expect(box).toHaveTextContent("1 pembayaran tanpa bukti dibatalkan.");
    expect(box).toHaveTextContent("1 pembayaran berbukti tetap di antrean verifikasi");
    expect(box).toHaveTextContent("6 refund senilai Rp360.000 dicatat untuk bendahara.");
    expect(screen.getByText(/Alasan: Lokasi terdampak banjir\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batalkan event" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ubah" })).toBeNull();
    const req = requests("POST", `/admin/events/${MOCK_EVENT_IDS.reuni}/cancel`)[0]!;
    expect(req.body).toEqual({ reason: "Lokasi terdampak banjir" });
    expect(req.ifMatch).toBe("3");
    expect(req.idempotencyKey).toBeTruthy();

    // Riwayat tidak dihapus: tiket tetap ada sebagai dibatalkan dengan refund menunggu (D6).
    await user.click(screen.getByRole("tab", { name: /Peserta & Tiket/ }));
    const table = await screen.findByRole("table", { name: "Peserta dan tiket" });
    const siti = rowOf(table, /Siti Rahmawati/);
    expect(within(siti).getByText("Dibatalkan")).toBeInTheDocument();
    expect(within(siti).getByText(/Refund menunggu Rp60\.000/)).toBeInTheDocument();
  });
});

describe("peserta dan tiket (F-09)", () => {
  it("F-09, AC F09-5, AC F14-4: menampilkan status tiket, penunjuk pembayaran, batas review, check-in beserta petugas, dan pemegang anonim", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=tickets`, REUNI);
    const table = await screen.findByRole("table", { name: "Peserta dan tiket" });
    const nurul = rowOf(table, /Nurul Hidayah/);
    expect(within(nurul).getByText("oleh Rahmat Hidayat")).toBeInTheDocument();
    const dewi = rowOf(table, /Dewi Lestari/);
    expect(within(dewi).getByText("Menunggu verifikasi")).toBeInTheDocument();
    expect(within(dewi).getByText("Lewat batas review")).toBeInTheDocument();
    // D6-02: tautan membuka payment tiket ini langsung di panel keputusan, bukan antrean bawaan.
    const paymentId = within(dewi).getByText(/^ID /).getAttribute("title");
    expect(paymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(dewi).getByRole("link", { name: "Putuskan di Verifikasi Pembayaran" })).toHaveAttribute(
      "href",
      `/payments?tab=verify&payment=${paymentId}`,
    );
    expect(within(dewi).getByText("Putuskan pembayaran dahulu")).toBeInTheDocument();
    expect(within(dewi).queryByRole("button", { name: /Batalkan tiket/ })).toBeNull();
    expect(within(rowOf(table, /Rina Marlina/)).getByText("Kedaluwarsa")).toBeInTheDocument();
    expect(within(rowOf(table, /Yusuf Maulana/)).getByText("Tidak memenuhi syarat")).toBeInTheDocument();
    expect(within(rowOf(table, /Akun dihapus/)).getByText("Data pemegang sudah dihapus")).toBeInTheDocument();
    expect(
      within(rowOf(table, /Fajar Nugroho/)).getByText("Dibatalkan peserta: Berhalangan hadir."),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Check-in" }), "true");
    await screen.findByText("Menampilkan 1 dari 1", {}, { timeout: SEARCH_WAIT });
    await user.selectOptions(screen.getByRole("combobox", { name: "Status tiket" }), "paid");
    await waitFor(() =>
      expect(requests("GET", `/admin/events/${MOCK_EVENT_IDS.reuni}/tickets`).at(-1)?.query).toMatchObject({
        status: "paid",
        checked_in: "true",
      }),
    );
  });

  it("D6: batalkan tiket lunas dengan refund penuh oleh pengurus berizin payments.decide", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=tickets`, REUNI);
    const table = await screen.findByRole("table", { name: "Peserta dan tiket" });
    await user.click(
      within(rowOf(table, /Siti Rahmawati/)).getByRole("button", { name: "Batalkan tiket Siti Rahmawati" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan tiket\?/ });
    await user.type(within(dialog).getByLabelText(/^Alasan pembatalan/), "Permintaan peserta sebelum H-3");
    await user.click(within(dialog).getByRole("checkbox", { name: /Saya memahami tiket ini/ }));
    await user.click(within(dialog).getByRole("button", { name: "Batalkan tiket" }));
    expect(await within(dialog).findByText("Pilih refund penuh atau tanpa refund.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /Refund penuh Rp60\.000/ }));
    await user.click(within(dialog).getByRole("button", { name: "Batalkan tiket" }));
    await findToast("success", "Refund Rp60.000 dicatat untuk bendahara.");
    const row = rowOf(await screen.findByRole("table", { name: "Peserta dan tiket" }), /Siti Rahmawati/);
    await waitFor(() => expect(within(row).getByText(/Refund menunggu Rp60\.000/)).toBeInTheDocument());
    const req = eventRequests.find((r) => r.path.endsWith("/cancel") && r.path.includes("/tickets/"))!;
    expect(req.body).toEqual({ reason: "Permintaan peserta sebelum H-3", refund: true });
    expect(req.ifMatch).toBe("1");
    expect(req.idempotencyKey).toBeTruthy();
  });

  it("PRD 2.3: tiket akun alumni tertaut pemanggil tidak menawarkan refund; dibatalkan tanpa refund", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=tickets`, REUNI);
    const table = await screen.findByRole("table", { name: "Peserta dan tiket" });
    await user.click(
      within(rowOf(table, /Bayu Musthafa/)).getByRole("button", { name: "Batalkan tiket Bayu Musthafa" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan tiket\?/ });
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByText(/Pilihan refund tidak tersedia untuk akun Anda/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Alasan pembatalan/), "Mundur dari kepanitiaan");
    await user.click(within(dialog).getByRole("checkbox", { name: /Saya memahami tiket ini/ }));
    await user.click(within(dialog).getByRole("button", { name: "Batalkan tiket" }));
    await findToast("success", "Tiket Bayu Musthafa dibatalkan.");
    const req = eventRequests.find((r) => r.path.endsWith("/cancel") && r.path.includes("/tickets/"))!;
    expect(req.body).toEqual({ reason: "Mundur dari kepanitiaan", refund: false });
  });

  it("AC F15-1: pengurus event tanpa payments.decide/payments.read tidak melihat pilihan refund dan tautan antrean", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.manage"] });
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.reuni}?tab=tickets`, REUNI);
    const table = await screen.findByRole("table", { name: "Peserta dan tiket" });
    expect(within(table).queryByRole("link", { name: "Putuskan di Verifikasi Pembayaran" })).toBeNull();
    await user.click(
      within(rowOf(table, /Siti Rahmawati/)).getByRole("button", { name: "Batalkan tiket Siti Rahmawati" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: /Batalkan tiket\?/ });
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).getByText(/memerlukan izin memutus pembayaran/)).toBeInTheDocument();
    // Tombol Check-in Tiket di halaman daftar tidak tampil tanpa events.checkin.
    await user.click(within(dialog).getByRole("button", { name: "Batal" }));
    await user.click(screen.getByRole("link", { name: "Event dan Tiket" }));
    await screen.findByRole("heading", { level: 1, name: "Event dan Tiket" });
    expect(screen.queryByRole("link", { name: /Check-in Tiket/, hidden: false })).toBeNull();
  });
});

describe("Manajemen Kategori event (guideline p14, izin events.manage)", () => {
  it("AC F15-1 (guideline p14): pengurus event menambah, menonaktifkan dan menghapus kategori event yang belum dipakai", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.manage"] });
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    await user.click(screen.getByRole("button", { name: "Manajemen Kategori" }));
    const sheet = await screen.findByRole("dialog", { name: "Manajemen Kategori Event" });
    await within(sheet).findByRole("heading", { name: /Kategori event \(\d+\)/ });
    await user.type(within(sheet).getByLabelText(/^Nama kategori/), "Bakti Sosial");
    // Batas kontrak AdminContentCategoryCreateRequest: urutan 0..32767.
    const order = within(sheet).getByLabelText(/^Urutan/);
    await user.clear(order);
    await user.type(order, "-1");
    await user.click(within(sheet).getByRole("button", { name: "Tambah kategori" }));
    expect(await within(sheet).findByText("Urutan harus bilangan bulat 0 atau lebih.")).toBeInTheDocument();
    expect(
      eventRequests.some((r) => r.method === "POST" && r.path === "/admin/content/event-categories"),
    ).toBe(false);
    await user.clear(order);
    await user.type(order, "6");
    await user.click(within(sheet).getByRole("button", { name: "Tambah kategori" }));
    await findToast("success", 'Kategori "Bakti Sosial" ditambahkan.');
    const created = eventRequests.find(
      (r) => r.method === "POST" && r.path === "/admin/content/event-categories",
    )!;
    // Slug kosong tidak dikirim (dibangkitkan server dari label).
    expect(created.body).toEqual({ label: "Bakti Sosial", sort_order: 6, active: true });
    expect(created.idempotencyKey).toBeTruthy();
    const item = (await within(sheet).findByText("Bakti Sosial")).closest("li")!;
    expect(within(item).getByText(/dipakai 0 event/)).toBeInTheDocument();
    await user.click(within(item).getByRole("switch", { name: /Tampil untuk event baru/ }));
    await waitFor(() =>
      expect(
        eventRequests.find(
          (r) => r.method === "PATCH" && r.path.startsWith("/admin/content/event-categories/"),
        )?.body,
      ).toEqual({
        active: false,
      }),
    );
    await waitFor(() =>
      expect(within(item).getByRole("switch", { name: /Tampil untuk event baru/ })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(within(item).getByText(/^Nonaktif: tidak dapat dipilih/)).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "Hapus kategori Bakti Sosial" }));
    const confirm = await screen.findByRole("alertdialog", { name: /Hapus kategori\?/ });
    await user.click(within(confirm).getByRole("checkbox"));
    await user.click(within(confirm).getByRole("button", { name: "Hapus kategori" }));
    await findToast("success", 'Kategori "Bakti Sosial" dihapus.');
    await waitFor(() => expect(within(sheet).queryByText("Bakti Sosial")).toBeNull());
  });

  it("AC F15-4: kategori diubah admin lain saat formulir ubah terbuka; simpan ditolak, versi terbaru ditawarkan dan tidak tertimpa", async () => {
    const tour = MOCK_EVENT_CATEGORY_IDS.tour;
    const patches = () => requests("PATCH", `/admin/content/event-categories/${tour}`);
    const user = userEvent.setup();
    await open(user, "/events", "Event dan Tiket");
    await user.click(screen.getByRole("button", { name: "Manajemen Kategori" }));
    const sheet = await screen.findByRole("dialog", { name: "Manajemen Kategori Event" });
    await user.click(await within(sheet).findByRole("button", { name: "Ubah kategori Tour" }));
    const editForm = within(sheet).getByRole("form", { name: "Ubah kategori Tour" });
    const label = within(editForm).getByLabelText(/^Nama kategori/);
    await user.clear(label);
    await user.type(label, "Wisata Alumni");
    // Sementara itu pengurus lain mengganti label (versi naik).
    mockEvents.editCategoryElsewhere(tour, { label: "Tour Religi" });
    await user.click(within(sheet).getByRole("button", { name: "Simpan" }));

    const alert = (await within(sheet).findByText(/sudah diubah admin lain/)).closest("[role=alert]")!;
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert).toHaveTextContent("Versi terbaru: Tour Religi");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]).toMatchObject({ ifMatch: "1", body: { label: "Wisata Alumni" } });
    // Tidak menimpa diam-diam: isian admin tetap, simpan dikunci sampai versi terbaru dimuat.
    expect(label).toHaveValue("Wisata Alumni");
    const save = within(sheet).getByRole("button", { name: "Simpan" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.click(save);
    expect(patches()).toHaveLength(1);
    expect(mockEvents.category(tour)!.label).toBe("Tour Religi");

    await user.click(within(sheet).getByRole("button", { name: "Muat versi terbaru" }));
    expect(label).toHaveValue("Tour Religi");
    expect(within(sheet).queryByText(/sudah diubah admin lain/)).toBeNull();
    await user.type(label, " 2026");
    await user.click(within(sheet).getByRole("button", { name: "Simpan" }));
    await findToast("success", 'Kategori "Tour Religi 2026" disimpan.');
    expect(patches()[1]).toMatchObject({ ifMatch: "2", body: { label: "Tour Religi 2026" } });
  });
});

describe("keadaan layar detail event (PRD 4.5)", () => {
  it("PRD 4.5: event yang tidak ada menampilkan Data tidak ditemukan", async () => {
    const user = userEvent.setup();
    renderApp("/events/0199e100-0000-7000-8000-0000000000ff");
    await signIn(user);
    // Potongan kode area dimuat lazy lalu detail diminta: beri waktu lebih dari bawaan 1 detik.
    expect(await screen.findByText("Data tidak ditemukan", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByText("Event tidak ditemukan.")).toBeInTheDocument();
  });

  it("PRD 4.5, AC F15-2: event tanpa tiket menampilkan keadaan kosong peserta; event selesai tidak dapat diubah", async () => {
    const user = userEvent.setup();
    await open(user, `/events/${MOCK_EVENT_IDS.mancing}?tab=tickets`, MANCING);
    expect(await screen.findByText("Belum ada peserta")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Event dan Tiket" }));
    const table = await screen.findByRole("table", { name: "Daftar event" });
    await user.click(
      within(rowOf(table, /Jalan Sehat Kemerdekaan/)).getByRole("link", { name: "Jalan Sehat Kemerdekaan" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Jalan Sehat Kemerdekaan" });
    expect(screen.queryByRole("tab", { name: "Ubah Event" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ubah" })).toBeNull();
    expect(screen.getByText("Selesai")).toBeInTheDocument();
  });
});
