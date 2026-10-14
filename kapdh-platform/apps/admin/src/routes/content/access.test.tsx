import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { mockAuth } from "../../api/mocks/auth";
import { contentRequests } from "../../api/mocks/content";
import { renderApp, signIn } from "../../test/utils";

// Suite admin berjalan paralel; potongan kode area dan editor dimuat lazy sehingga butuh waktu tunggu lebih.
configure({ asyncUtilTimeout: 5000 });

beforeAll(async () => {
  // Potongan kode area dan editor dimuat lazy; muat lebih dahulu agar waktu transformasi modul saat suite berjalan
  // paralel tidak dihitung sebagai waktu tunggu UI.
  await Promise.all([import("./ContentPages"), import("../../components/ui/RichTextEditorImpl")]);
}, 60_000);

describe("izin Manajemen Konten (AC F15-1, F16-3; server tiruan)", () => {
  it("AC F15-1: admin pembayaran tanpa content.manage tidak melihat menu konten dan /content ditolak tanpa memanggil API konten", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    const user = userEvent.setup();
    renderApp("/content");
    const nav = await signIn(user);
    expect(within(nav).queryByRole("link", { name: /Manajemen Konten/ })).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Akses ditolak" }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Daftar berita" })).toBeNull();
    expect(contentRequests).toHaveLength(0);
  });

  it("AC F15-1: editor berita juga dijaga rute; tanpa izin tidak ada formulir", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["events.manage"] });
    const user = userEvent.setup();
    renderApp("/content/posts/new");
    await signIn(user);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Akses ditolak" }, { timeout: 8000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Judul konten/ })).toBeNull();
  });

  it("AC F16-3: izin dicabut saat halaman terbuka → API menolak 403 dan halaman berganti ke Akses ditolak", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["content.manage"] });
    const user = userEvent.setup();
    renderApp("/content");
    const nav = await signIn(user);
    expect(within(nav).getByRole("link", { name: /Manajemen Konten/ })).toBeInTheDocument();
    await screen.findByRole("table", { name: "Daftar berita" }, { timeout: 8000 });

    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "draft");
    // PermissionGate di dalam halaman menggantikan tabel setelah izin dimuat ulang (judul halaman tetap).
    await waitFor(() => expect(screen.queryByRole("table", { name: "Daftar berita" })).toBeNull(), {
      timeout: 8000,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Akses ditolak");
    const last = contentRequests.at(-1);
    expect(last).toMatchObject({ path: "/admin/content/posts", query: { state: "draft" } });
    // Menu konten ikut hilang setelah izin dimuat ulang dari server.
    await screen.findByRole("navigation", { name: "Menu admin" });
    expect(
      within(screen.getByRole("navigation", { name: "Menu admin" })).queryByRole("link", {
        name: /Manajemen Konten/,
      }),
    ).toBeNull();
  });
});
