import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks";
import {
  MOCK_DELIVERY_IDS,
  MOCK_OUTBOX_IDS,
  mockNotifications,
  notificationJobCounts,
  notificationRequests,
} from "../../api/mocks/notifications";
import { openPage, section } from "../../test/governance";
import { findToast, renderApp, signIn } from "../../test/utils";
import { DELIVERY_SKIP_LABEL, summarizeSkips } from "./NotificationsPage";
import { validateNotificationsSearch } from "./routes";

const deliveryLists = () => notificationRequests.filter((r) => r.path === "/admin/notifications/deliveries");
const retries = (path: string) => notificationRequests.filter((r) => r.method === "POST" && r.path === path);

describe("notifikasi (F-13, AC F13-4, F13-5; server tiruan)", () => {
  it("summarizeSkips dan validasi parameter URL", () => {
    expect(summarizeSkips(["token_revoked", "not_found", "token_revoked"], DELIVERY_SKIP_LABEL)).toBe(
      "token perangkat sudah dicabut (2); tidak ditemukan (1)",
    );
    expect(validateNotificationsSearch({ tab: "outbox", since: "bukan-waktu" })).toEqual({ tab: "outbox" });
    expect(validateNotificationsSearch({ tab: "x", since: "2026-10-06T00:00:00Z" })).toEqual({
      since: "2026-10-06T00:00:00Z",
    });
  });

  it("AC F13-4: daftar pengiriman menampilkan kelas galat dan hanya kegagalan yang dapat ditindak bisa dikirim ulang", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    const table = await screen.findByRole("table", { name: "Hasil pengiriman notifikasi" });
    expect(screen.getByText("Menampilkan 12 dari 12")).toBeInTheDocument();
    // UNREGISTERED: token dinonaktifkan, tidak ada tombol kirim ulang.
    const unregistered = within(table).getByText("UNREGISTERED").closest("tr")!;
    expect(within(unregistered).getByText(/token dinonaktifkan \(AC F13-4\)/)).toBeInTheDocument();
    expect(within(unregistered).getByText("Tidak dapat dikirim ulang")).toBeInTheDocument();
    expect(within(unregistered).queryByRole("button", { name: /^Kirim ulang/ })).toBeNull();
    // 5xx: dicoba ulang otomatis; setelah batas percobaan menjadi gagal dan dapat dikirim ulang pengurus.
    const unavailable = within(table).getByText("UNAVAILABLE").closest("tr")!;
    expect(within(unavailable).getByText(/dicoba ulang otomatis dengan jeda/)).toBeInTheDocument();
    expect(within(unavailable).getByText("Push (iOS)")).toBeInTheDocument();
    expect(within(unavailable).getByRole("button", { name: /^Kirim ulang pengiriman Event/ })).toBeVisible();
    // Token yang berpindah akun dibatalkan dan tidak dikirimi lagi (AC F13-5).
    expect(within(table).getAllByText(/kini dipakai akun lain/).length).toBeGreaterThan(0);
    // Privasi: tidak ada token, email maupun isi notifikasi.
    expect(table.textContent).not.toMatch(/@|token:/i);
    expect(deliveryLists()[0]?.query).toMatchObject({ sort: "created_at_desc", limit: "30" });
    expect(deliveryLists()[0]?.background).toBe(false);
  });

  it("filter status dan dapat dikirim ulang dikirim sebagai parameter server", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    await screen.findByText("Menampilkan 12 dari 12");
    const filter = await section("Filter pengiriman");
    await user.selectOptions(within(filter).getByLabelText("Status"), "failed");
    await user.selectOptions(within(filter).getByLabelText("Dapat dikirim ulang"), "true");
    await user.click(within(filter).getByRole("button", { name: "Terapkan filter" }));
    await screen.findByText("Menampilkan 4 dari 4");
    expect(deliveryLists().at(-1)?.query).toMatchObject({ status: "failed", retryable: "true" });
  });

  it("validasi filter: id penerima harus UUID", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    await screen.findByText("Menampilkan 12 dari 12");
    const before = deliveryLists().length;
    const filter = await section("Filter pengiriman");
    await user.type(within(filter).getByLabelText("Id akun penerima"), "bukan-uuid");
    await user.click(within(filter).getByRole("button", { name: "Terapkan filter" }));
    await waitFor(() =>
      expect(within(filter).getByLabelText("Id akun penerima")).toHaveAccessibleDescription(
        /harus berupa UUID/,
      ),
    );
    expect(deliveryLists()).toHaveLength(before);
  });

  it("AC F13-4: kirim ulang satu pengiriman memakai Idempotency-Key dan statusnya menjadi Menunggu", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    const table = await screen.findByRole("table", { name: "Hasil pengiriman notifikasi" });
    const row = within(table).getByText("UNAVAILABLE").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /^Kirim ulang pengiriman Event/ }));
    expect(await screen.findByText("1 pengiriman dijadwalkan ulang.")).toBeInTheDocument();
    const call = retries("/admin/notifications/deliveries/retry")[0]!;
    expect(call.body).toEqual({ delivery_ids: [MOCK_DELIVERY_IDS.unavailable] });
    expect(call.idempotencyKey).toBeTruthy();
    expect(mockNotifications.delivery(MOCK_DELIVERY_IDS.unavailable)?.status).toBe("pending");
    await waitFor(() => expect(within(row).getByText("Menunggu")).toBeInTheDocument());
  });

  it("kirim ulang massal melaporkan pengiriman yang dilewati beserta alasannya", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    await screen.findByRole("table", { name: "Hasil pengiriman notifikasi" });
    await user.click(
      screen.getByRole("checkbox", { name: /Pilih pengiriman Pembayaran Push \(Android\) ke Bayu/ }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: /Pilih pengiriman Pembayaran Email ke Sari Dewi/ }),
    );
    expect(screen.getByText("2 baris dipilih")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Kirim ulang terpilih" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Kirim ulang 2 pengiriman?" });
    await user.click(within(dialog).getByRole("button", { name: "Ya, kirim ulang" }));
    expect(
      await screen.findByText(
        "1 pengiriman dijadwalkan ulang. 1 dilewati: token perangkat sudah dicabut (1).",
      ),
    ).toBeInTheDocument();
    const body = retries("/admin/notifications/deliveries/retry")[0]?.body as { delivery_ids: string[] };
    expect([...body.delivery_ids].sort()).toEqual(
      [MOCK_DELIVERY_IDS.bounceSoft, MOCK_DELIVERY_IDS.unregistered].sort(),
    );
    await waitFor(() => expect(screen.queryByText(/baris dipilih/)).toBeNull());
  });

  it("batas kirim ulang per admin (429) ditampilkan sebagai galat tanpa mengubah data", async () => {
    mockNotifications.limitRetries();
    const user = userEvent.setup();
    await openPage(user, "/notifications", "Notifikasi");
    const table = await screen.findByRole("table", { name: "Hasil pengiriman notifikasi" });
    const row = within(table).getByText("bounce_hard").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /^Kirim ulang/ }));
    expect(await findToast("error", /Terlalu banyak permintaan kirim ulang/)).toBeInTheDocument();
    expect(mockNotifications.delivery(MOCK_DELIVERY_IDS.bounceHard)?.status).toBe("failed");
  });

  it("tautan dasbor ?since= membuka kegagalan yang dapat ditindak dengan total sama dengan hitungan dasbor", async () => {
    const counts = notificationJobCounts();
    const user = userEvent.setup();
    renderApp(`/notifications?since=${encodeURIComponent(counts.failed_delivery_since)}`);
    await signIn(user);
    await screen.findByRole("heading", { level: 1, name: "Notifikasi" }, { timeout: 5_000 });
    expect(counts.failed_delivery_count).toBe(3);
    await screen.findByText(
      `Menampilkan ${counts.failed_delivery_count} dari ${counts.failed_delivery_count}`,
    );
    expect(deliveryLists()[0]?.query).toMatchObject({
      status: "failed",
      retryable: "true",
      from: counts.failed_delivery_since,
    });
    const filter = await section("Filter pengiriman");
    expect(within(filter).getByLabelText("Status")).toHaveValue("failed");
  });

  it("outbox: bawaan hanya event gagal/berhenti; event yang sedang diklaim dispatcher dilewati saat dikembalikan", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications?tab=outbox", "Notifikasi");
    const table = await screen.findByRole("table", { name: "Event outbox" });
    expect(screen.getByText("Menampilkan 4 dari 4")).toBeInTheDocument();
    const outboxList = notificationRequests.find((r) => r.path === "/admin/notifications/outbox");
    expect(outboxList?.query.status).toBeUndefined();
    const locked = within(table).getByText("audit.export.requested").closest("tr")!;
    expect(within(locked).getByText("Sedang diproses dispatcher")).toBeInTheDocument();
    expect(within(locked).queryByRole("button", { name: /Kembalikan/ })).toBeNull();
    // Payload dan dedup key tidak pernah tampil; request_id untuk menelusuri log.
    expect(within(table).getByText("req-00e201")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Pilih event Ekspor audit/ }));
    await user.click(screen.getByRole("checkbox", { name: /Pilih event Reset sandi anggota/ }));
    await user.click(screen.getByRole("button", { name: "Kembalikan terpilih ke antrean" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Kembalikan 2 event ke antrean?" });
    await user.click(within(dialog).getByRole("button", { name: "Ya, kembalikan" }));
    expect(
      await screen.findByText(
        "1 event dikembalikan ke antrean. 1 dilewati: sedang diproses dispatcher; coba lagi setelah selesai (1).",
      ),
    ).toBeInTheDocument();
    expect(mockNotifications.outboxEvent(MOCK_OUTBOX_IDS.deadReset)?.status).toBe("pending");
    expect(mockNotifications.outboxEvent(MOCK_OUTBOX_IDS.deadExportLocked)?.status).toBe("dead");
    expect(retries("/admin/notifications/outbox/retry")[0]?.idempotencyKey).toBeTruthy();
    // Event yang dikembalikan keluar dari daftar "perlu tindakan".
    await screen.findByText("Menampilkan 3 dari 3");
  });

  it("outbox: filter status dan topik dikirim sebagai parameter server", async () => {
    const user = userEvent.setup();
    await openPage(user, "/notifications?tab=outbox", "Notifikasi");
    await screen.findByText("Menampilkan 4 dari 4");
    await user.selectOptions(screen.getByLabelText("Status"), "dead");
    await screen.findByText("Menampilkan 3 dari 3");
    await user.selectOptions(screen.getByLabelText("Topik"), "notification.created");
    await screen.findByText("Menampilkan 1 dari 1");
    expect(notificationRequests.at(-1)?.query).toMatchObject({
      status: "dead",
      topic: "notification.created",
    });
  });

  it("AC F15-1: admin tanpa notifications.manage tidak dapat membuka halaman dan API tidak dipanggil", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read", "moderation.read"] });
    const user = userEvent.setup();
    renderApp("/notifications");
    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Akses ditolak" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Notifikasi/ })).toBeNull();
    expect(notificationRequests).toHaveLength(0);
  });
});
