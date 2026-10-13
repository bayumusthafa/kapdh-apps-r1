import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAuth } from "../../api/mocks";
import { eventRequests, MOCK_EVENT_IDS, MOCK_TICKET_IDS, MOCK_TICKET_QR, mockEvents } from "../../api/mocks/events";
import { renderApp, signIn, type User } from "../../test/utils";

/**
 * Pemindai check-in (AC F09-5, F09-6, D5) di server tiruan; bukti AC sisi server ada di uji API events
 * (PRD 7.3). Kamera @zxing/browser diganti tiruan yang memanggil callback decode secara manual.
 */
const zxing = vi.hoisted(() => ({
  callback: null as null | ((result: { getText(): string } | undefined) => void),
  stop: vi.fn(),
  fail: null as Error | null,
  constraints: null as MediaStreamConstraints | null,
}));

vi.mock("@zxing/browser", () => ({
  BrowserQRCodeReader: class {
    static listVideoInputDevices = async () => [{ deviceId: "cam-1", label: "Kamera belakang" }];
    async decodeFromConstraints(
      constraints: MediaStreamConstraints,
      _video: unknown,
      cb: (result: { getText(): string } | undefined) => void,
    ) {
      if (zxing.fail) throw zxing.fail;
      zxing.constraints = constraints;
      zxing.callback = cb;
      return { stop: zxing.stop };
    }
  },
}));

beforeEach(() => {
  zxing.callback = null;
  zxing.fail = null;
  zxing.constraints = null;
  zxing.stop.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const checkinPosts = () => eventRequests.filter((r) => r.method === "POST" && r.path === "/admin/checkin");

async function openScanner(user: User, eventName = /Reuni Akbar KAPDH 2026/) {
  renderApp("/events/checkin");
  await signIn(user);
  await screen.findByRole("heading", { level: 1, name: "Check-in Tiket" });
  await user.click(await screen.findByRole("radio", { name: eventName }));
  const input = await screen.findByLabelText(/^Kode tiket/);
  await waitFor(() => expect(input).toHaveFocus());
  return input;
}

async function scan(user: User, input: HTMLElement, code: string) {
  await user.clear(input);
  await user.type(input, `${code}{Enter}`);
}

function resultCard() {
  return screen.getByRole("region", { name: "Hasil pemindaian" });
}

describe("check-in tiket (AC F09-5, F09-6; server tiruan)", () => {
  it("AC F09-5: tiket lunas dalam jendela tercatat sekali; scan kedua menampilkan Sudah check-in dengan waktu dan petugas", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    expect(screen.getByText("Hadir 1 dari 6 tiket lunas")).toBeInTheDocument();

    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
    const card = resultCard();
    expect(within(card).getByRole("heading", { name: "Check-in berhasil" })).toBeInTheDocument();
    expect(within(card).getByText("Siti Rahmawati")).toBeInTheDocument();
    expect(within(card).getByText(/oleh Bayu Musthafa/)).toBeInTheDocument();
    expect(screen.getByText("Hadir 2 dari 6 tiket lunas")).toBeInTheDocument();
    // Kartu hasil adalah region live sehingga pembaca layar membacakan setiap hasil (N-11).
    expect(card).toHaveAttribute("aria-live", "assertive");
    // Isian dikosongkan dan tetap difokus untuk pemindaian berikutnya (pemindai genggam/keyboard).
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "already_checked_in"));
    expect(within(resultCard()).getByRole("heading", { name: "Sudah check-in" })).toBeInTheDocument();
    expect(within(resultCard()).getByText(/Sebelumnya check-in .* oleh Bayu Musthafa\./)).toBeInTheDocument();
    // Tidak menambah hitungan hadir.
    expect(screen.getByText("Hadir 2 dari 6 tiket lunas")).toBeInTheDocument();
    const posts = checkinPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual({ event_id: MOCK_EVENT_IDS.reuni, qr_code: MOCK_TICKET_QR.paid });
    // Setiap pemindaian adalah niat baru (key baru) setelah hasil sebelumnya diketahui.
    expect(posts[0]!.idempotencyKey).toBeTruthy();
    expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
  });

  it("AC F09-5: tiket yang sudah dipindai petugas lain menampilkan waktu dan nama petugas sebelumnya", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    await scan(user, input, MOCK_TICKET_QR.checkedIn);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "already_checked_in"));
    expect(within(resultCard()).getByText("Nurul Hidayah")).toBeInTheDocument();
    expect(within(resultCard()).getByText(/oleh Rahmat Hidayat\./)).toBeInTheDocument();
  });

  it.each([
    ["QR event lain", MOCK_TICKET_QR.seminar, "other_event", "Tiket event lain", /^Tiket untuk: Seminar AI untuk Alumni/],
    ["menunggu verifikasi", MOCK_TICKET_QR.review, "ticket_awaiting_review", "Pembayaran belum diverifikasi", /Verifikasi Pembayaran/],
    ["menunggu pembayaran", MOCK_TICKET_QR.awaitingPayment, "ticket_awaiting_payment", "Belum dibayar", /tiket lunas/],
    ["hold kedaluwarsa (proyeksi baca)", MOCK_TICKET_QR.holdExpired, "ticket_expired", "Tiket kedaluwarsa", /mendaftar ulang/],
    ["tiket dibatalkan", MOCK_TICKET_QR.cancelled, "ticket_cancelled", "Tiket dibatalkan", /tidak berlaku/],
    ["pemegang disuspend", MOCK_TICKET_QR.ineligible, "holder_ineligible", "Pemegang tidak memenuhi syarat", /dibatasi/],
  ])("AC F09-6: %s ditolak dengan alasan yang dapat ditindaklanjuti", async (_label, code, reason, title, action) => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    await scan(user, input, code);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", reason));
    expect(within(resultCard()).getByRole("heading", { name: title })).toBeInTheDocument();
    expect(within(resultCard()).getByText(action)).toBeInTheDocument();
    // Hitungan hadir tidak berubah karena penolakan.
    expect(screen.getByText("Hadir 1 dari 6 tiket lunas")).toBeInTheDocument();
  });

  it("AC F09-6: di luar jendela check-in (terlalu awal) menampilkan jendela efektif D5", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user, /Kajian Subuh Bersama/);
    expect(screen.getByText("Check-in belum dibuka")).toBeInTheDocument();
    await scan(user, input, MOCK_TICKET_QR.kajian);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "too_early"));
    expect(within(resultCard()).getByRole("heading", { name: "Check-in belum dibuka" })).toBeInTheDocument();
    expect(within(resultCard()).getByText(/^Jendela check-in: /)).toBeInTheDocument();
  });

  it("AC F09-6: jendela sudah berakhir ditolak Check-in sudah ditutup", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    mockEvents.setCheckinWindow(MOCK_EVENT_IDS.reuni, Date.now() - 5 * 3_600_000, Date.now() - 60_000);
    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "too_late"));
    expect(within(resultCard()).getByRole("heading", { name: "Check-in sudah ditutup" })).toBeInTheDocument();
  });

  it("AC F09-7: event dibatalkan saat petugas memindai, QR tiket tidak berlaku lagi", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    mockEvents.cancelElsewhere(MOCK_EVENT_IDS.reuni);
    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "event_cancelled"));
    expect(within(resultCard()).getByRole("heading", { name: "Event dibatalkan" })).toBeInTheDocument();
    expect(within(resultCard()).getByText(/informasi refund/)).toBeInTheDocument();
  });

  it("QR yang bukan tiket KAPDH ditolak dengan petunjuk QR tiket vs QR KTA", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    await scan(user, input, "https://kapdh.or.id/kta/29.01.02.15#t=abc");
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "not_found"));
    expect(within(resultCard()).getByRole("heading", { name: "QR tidak dikenal" })).toBeInTheDocument();
    expect(within(resultCard()).getByText(/bukan QR KTA/)).toBeInTheDocument();
  });

  it("isian kosong tidak dikirim dan galatnya terbaca di isian", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    await user.type(input, "   {Enter}");
    expect(await screen.findByText("Ketik atau pindai kode tiket.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(checkinPosts()).toHaveLength(0);
  });

  it("PRD 4.3: jaringan putus menampilkan status belum diketahui; kirim ulang memakai key yang sama dan tercatat sekali", async () => {
    const user = userEvent.setup();
    const input = await openScanner(user);
    mockEvents.failCheckins(1);
    await scan(user, input, MOCK_TICKET_QR.paid2);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "unknown"));
    expect(within(resultCard()).getByRole("heading", { name: "Status belum diketahui" })).toBeInTheDocument();
    // Kode dipertahankan agar petugas cukup menekan Check-in lagi.
    expect(input).toHaveValue(MOCK_TICKET_QR.paid2);
    await user.click(screen.getByRole("button", { name: "Check-in" }));
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
    const posts = checkinPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey);
    expect(screen.getByText("Hadir 2 dari 6 tiket lunas")).toBeInTheDocument();
  });

  it("kamera: hasil decode @zxing/browser dikirim sebagai check-in; QR yang sama berturut-turut diabaikan", async () => {
    const user = userEvent.setup();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "Nyalakan kamera" }));
    await waitFor(() => expect(zxing.callback).not.toBeNull());
    // Kamera belakang dipilih bawaan.
    expect(zxing.constraints?.video).toEqual({ facingMode: "environment" });
    expect(await screen.findByRole("button", { name: "Matikan kamera" })).toBeInTheDocument();
    await act(async () => {
      zxing.callback!({ getText: () => MOCK_TICKET_QR.paid });
    });
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
    await act(async () => {
      zxing.callback!({ getText: () => MOCK_TICKET_QR.paid });
    });
    expect(checkinPosts()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Matikan kamera" }));
    expect(zxing.stop).toHaveBeenCalled();
  });

  it("kamera ditolak: pesan yang dapat ditindaklanjuti dan input manual tetap tersedia", async () => {
    const user = userEvent.setup();
    zxing.fail = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const input = await openScanner(user);
    await user.click(screen.getByRole("button", { name: "Nyalakan kamera" }));
    expect(await screen.findByText(/Izin kamera ditolak/)).toBeInTheDocument();
    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
  });

  it("N-11: pilih event dengan keyboard lalu kirim kode dengan Enter", async () => {
    const user = userEvent.setup();
    renderApp("/events/checkin");
    await signIn(user);
    const radio = await screen.findByRole("radio", { name: /Reuni Akbar KAPDH 2026/ });
    radio.focus();
    await user.keyboard(" ");
    const input = await screen.findByLabelText(/^Kode tiket/);
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard(`${MOCK_TICKET_QR.paid}{Enter}`);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
  });

  it("tidak ada event dalam 24 jam: keadaan kosong dijelaskan", async () => {
    mockEvents.cancelElsewhere(MOCK_EVENT_IDS.reuni);
    mockEvents.cancelElsewhere(MOCK_EVENT_IDS.kajian);
    const user = userEvent.setup();
    renderApp("/events/checkin");
    await signIn(user);
    expect(await screen.findByText("Tidak ada event untuk dipindai")).toBeInTheDocument();
  });

  it("AC F15-1: admin dengan events.checkin saja dapat memindai tanpa izin events.manage", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin"] });
    const user = userEvent.setup();
    const input = await openScanner(user);
    await scan(user, input, MOCK_TICKET_QR.paid);
    await waitFor(() => expect(resultCard()).toHaveAttribute("data-result", "success"));
  });

  it("AC F15-1: admin tanpa events.checkin tidak dapat membuka pemindai walau URL diketik langsung", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.manage"] });
    const user = userEvent.setup();
    renderApp("/events/checkin");
    await signIn(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Akses ditolak");
    expect(eventRequests.some((r) => r.path === "/admin/checkin/events")).toBe(false);
  });

  it("AC F16-3 (UI): izin check-in dicabut di tengah sesi, pemindaian ditolak server lalu halaman tertutup", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.checkin", "audit.read"] });
    const user = userEvent.setup();
    const input = await openScanner(user);
    mockAuth.setAdmin({ permissions: ["audit.read"] });
    await scan(user, input, MOCK_TICKET_QR.paid);
    // 403 memuat ulang izin dari server; rute tanpa izin berganti menjadi Akses ditolak (bukan data basi).
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(mockEvents.ticket(MOCK_TICKET_IDS.paid)?.checked_in_at).toBeNull();
  });
});
