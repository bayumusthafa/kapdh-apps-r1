import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/errors";
import { mockAuth } from "../../api/mocks";
import { renderWithProviders, signInViaApi, toasts } from "../../test/utils";
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  type ComboboxOption,
  ConfirmDialog,
  DateTimeField,
  Dialog,
  ErrorState,
  Field,
  IconButton,
  MembershipStatusBadge,
  MoneyField,
  PaymentStatusBadge,
  PermissionGate,
  RadioGroup,
  SearchInput,
  Switch,
  Tabs,
  TabPanel,
  ToastProvider,
  Tooltip,
  useToast,
} from "./index";

describe("Button dan IconButton", () => {
  it("loading: aria-busy, tetap dapat difokus, klik diabaikan", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading loadingText="Menyimpan..." onClick={onClick}>
        Simpan
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Menyimpan..." });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).not.toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("tombol ikon wajib berlabel dan menampilkan tooltip saat fokus keyboard", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Hapus Siti Rahmawati" tone="danger" icon={<span>x</span>} />);
    await user.tab();
    const btn = screen.getByRole("button", { name: "Hapus Siti Rahmawati" });
    expect(btn).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hapus Siti Rahmawati");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("Tooltip dengan describe menautkan aria-describedby", () => {
    render(
      <Tooltip content="Data diekspor sesuai filter">
        <button type="button">Ekspor</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Ekspor" })).toHaveAccessibleDescription(
      "Data diekspor sesuai filter",
    );
  });
});

describe("Badge status (PRD 4.5: tidak hanya warna)", () => {
  it("status pembayaran dan keanggotaan selalu berlabel teks", () => {
    render(
      <>
        <PaymentStatusBadge status="pending" />
        <MembershipStatusBadge status="expired" />
        <MembershipStatusBadge status="verified" />
        <Badge tone="gold">Baru</Badge>
      </>,
    );
    expect(screen.getByText("Menunggu")).toBeInTheDocument();
    expect(screen.getByText("KTA Kedaluwarsa").closest("span")).toHaveClass("badge-expired");
    expect(screen.getByText("KTA Aktif")).toBeInTheDocument();
  });
});

describe("Tabs (WAI-ARIA)", () => {
  function Harness() {
    const [value, setValue] = useState<"a" | "b" | "c">("a");
    return (
      <>
        <Tabs
          label="Menu pembayaran"
          idPrefix="t"
          value={value}
          onValueChange={setValue}
          items={[
            { value: "a", label: "Verifikasi" },
            { value: "b", label: "Metode" },
            { value: "c", label: "Biaya" },
          ]}
        />
        <TabPanel idPrefix="t" value={value}>
          Panel {value}
        </TabPanel>
      </>
    );
  }

  it("panah kiri/kanan, Home/End memindah tab aktif dengan roving tabindex", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    await user.tab();
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Metode" })).toHaveTextContent("Panel b");
    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
  });
});

describe("Dialog dan ConfirmDialog", () => {
  function DialogHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Buka
        </button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Ubah kategori"
          description="Nama kategori tampil di aplikasi."
          footer={<button type="button">Simpan</button>}
        >
          <input aria-label="Nama" />
        </Dialog>
      </>
    );
  }

  it("fokus masuk, Tab berputar di dalam, Escape menutup dan fokus kembali ke pemicu", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Buka" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Ubah kategori" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Nama kategori tampil di aplikasi.");
    const close = within(dialog).getByRole("button", { name: "Tutup" });
    expect(close).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("textbox", { name: "Nama" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Simpan" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Simpan" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("jebakan fokus memakai perhentian Tab saja: Tabs roving di akhir dialog tidak membuat fokus lolos", async () => {
    const user = userEvent.setup();
    function RovingHarness() {
      const [open, setOpen] = useState(false);
      const [tab, setTab] = useState<"a" | "b" | "c">("a");
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Buka
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Detail">
            <Tabs<"a" | "b" | "c">
              label="Bagian detail"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: "a", label: "Ringkas" },
                { value: "b", label: "Riwayat" },
                { value: "c", label: "Berkas" },
              ]}
            />
          </Dialog>
        </>
      );
    }
    render(<RovingHarness />);
    await user.click(screen.getByRole("button", { name: "Buka" }));
    const dialog = screen.getByRole("dialog", { name: "Detail" });
    const close = within(dialog).getByRole("button", { name: "Tutup" });
    expect(close).toHaveFocus();
    await user.tab();
    // Tab terpilih ("Ringkas") adalah perhentian Tab terakhir walau bukan elemen terakhir di DOM.
    expect(within(dialog).getByRole("tab", { name: "Ringkas" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("tab", { name: "Ringkas" })).toHaveFocus();
  });

  function ConfirmHarness({ onConfirm, confirmText }: { onConfirm: () => void; confirmText?: string }) {
    const [open, setOpen] = useState(true);
    return (
      <ConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={onConfirm}
        title="Hapus banner?"
        description="Banner tidak tampil lagi di beranda."
        confirmLabel="Hapus banner"
        confirmText={confirmText}
      />
    );
  }

  it("dua langkah: Batal terfokus, konfirmasi aktif setelah pernyataan dicentang", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("alertdialog", { name: /Hapus banner\?/ });
    expect(within(dialog).getByRole("button", { name: "Batal" })).toHaveFocus();
    const confirm = within(dialog).getByRole("button", { name: "Hapus banner" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: "Saya memahami akibat tindakan ini." }));
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("dengan confirmText admin harus mengetik teks persis; Escape membatalkan", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} confirmText="Reuni Akbar" />);
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Hapus banner" });
    await user.type(within(dialog).getByRole("textbox", { name: /Ketik Reuni Akbar/ }), "Reuni");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: /Ketik Reuni Akbar/ }), " Akbar");
    expect(confirm).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("kontrol formulir", () => {
  it("Field menautkan label, petunjuk dan galat; status galat lewat aria-invalid", () => {
    render(
      <Field label="Nama event" hint="Maksimal 120 karakter." error="Nama wajib diisi." required>
        {(a11y) => <input {...a11y} />}
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: /Nama event/ });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAccessibleDescription("Nama wajib diisi. Maksimal 120 karakter.");
  });

  it("Switch: role switch, Spasi mengubah status, label status tertulis", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Mode pemeliharaan" checked={on} onCheckedChange={setOn} />;
    }
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Mode pemeliharaan" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("Nonaktif");
    sw.focus();
    await user.keyboard(" ");
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).toHaveTextContent("Aktif");
  });

  it("Checkbox dan RadioGroup memakai input native berlabel", async () => {
    const user = userEvent.setup();
    const onChecked = vi.fn();
    function Harness() {
      const [v, setV] = useState<"bank" | "ewallet" | null>(null);
      return (
        <>
          <Checkbox label="Tampilkan di direktori" onCheckedChange={onChecked} />
          <RadioGroup
            legend="Jenis metode"
            value={v}
            onValueChange={setV}
            options={[
              { value: "bank", label: "Transfer bank" },
              { value: "ewallet", label: "E-wallet" },
            ]}
            error={v ? null : "Pilih salah satu."}
          />
        </>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: "Tampilkan di direktori" }));
    expect(onChecked).toHaveBeenCalledWith(true);
    const group = screen.getByRole("group", { name: "Jenis metode" });
    expect(group).toHaveAccessibleDescription("Pilih salah satu.");
    await user.click(within(group).getByRole("radio", { name: "Transfer bank" }));
    await user.keyboard("{ArrowDown}");
    expect(within(group).getByRole("radio", { name: "E-wallet" })).toBeChecked();
  });

  it("MoneyField menghasilkan Money desimal string tanpa float dan memformat saat blur", async () => {
    const user = userEvent.setup();
    const values: string[] = [];
    function Harness() {
      const [v, setV] = useState("");
      return (
        <Field label="Biaya perpanjangan">
          {(a11y) => (
            <MoneyField
              {...a11y}
              value={v}
              onValueChange={(next) => {
                values.push(next);
                setV(next);
              }}
            />
          )}
        </Field>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Biaya perpanjangan" });
    await user.type(input, "60000");
    expect(values.at(-1)).toBe("60000.00");
    await user.tab();
    expect(input).toHaveValue("60.000");
    await user.clear(input);
    await user.type(input, "12,5x");
    expect(values.at(-1)).toBe("12,5x");
  });

  it("DateTimeField: jam dinding WIB disimpan sebagai ISO UTC", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Field label="Mulai">
        {(a11y) => <DateTimeField {...a11y} value={null} onValueChange={onChange} />}
      </Field>,
    );
    const input = screen.getByLabelText("Mulai");
    await user.type(input, "2026-10-12T14:20");
    expect(onChange).toHaveBeenLastCalledWith("2026-10-12T07:20:00.000Z");
    expect(screen.getByText("WIB")).toBeInTheDocument();
  });

  it("SearchInput: debounce, Escape mengosongkan", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchInput label="Cari" value="" onValueChange={onChange} delayMs={50} />);
    const box = screen.getByRole("searchbox", { name: "Cari" });
    await user.type(box, "Siti");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Siti"));
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(""));
  });

  it("Combobox async: hasil diumumkan, panah + Enter memilih, kueri lama dibatalkan", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const aborted: string[] = [];
    const load = (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
      calls.push(q);
      signal.addEventListener("abort", () => aborted.push(q));
      return Promise.resolve(
        [
          { value: "1", label: "Siti Rahmawati", description: "27.02.02.5" },
          { value: "2", label: "Siti Aminah", description: "21.01.02.4" },
        ].filter((o) => o.label.toLowerCase().includes(q.toLowerCase())),
      );
    };
    function Harness() {
      const [v, setV] = useState<ComboboxOption | null>(null);
      return (
        <>
          <Combobox label="Alumni" value={v} onValueChange={setV} loadOptions={load} delayMs={10} />
          <p>Terpilih: {v?.label ?? "-"}</p>
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Alumni" });
    await user.type(input, "siti");
    const list = await screen.findByRole("listbox", { name: "Alumni" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/2 hasil tersedia/)).toBeInTheDocument();
    // Debounce 10 ms dapat terlewati di antara ketikan saat mesin uji sibuk (turbo paralel), sehingga kueri antara
    // seperti "sit" boleh terkirim; yang dijamin: kueri terakhir "siti" dan SETIAP kueri lama dibatalkan (abort).
    expect(calls.at(-1)).toBe("siti");
    expect(aborted).toEqual(calls.slice(0, -1));
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/opt-1$/);
    await user.keyboard("{Enter}");
    expect(screen.getByText("Terpilih: Siti Aminah")).toBeInTheDocument();
    expect(input).toHaveValue("Siti Aminah");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Hapus pilihan Siti Aminah" }));
    expect(screen.getByText("Terpilih: -")).toBeInTheDocument();
  });
});

describe("ErrorState memetakan katalog ERROR_UI", () => {
  it.each([
    [
      new ApiError({
        code: "NETWORK",
        status: 0,
        message: "Tidak dapat terhubung. Periksa koneksi internet lalu coba lagi.",
      }),
      "Tidak dapat terhubung",
    ],
    [new ApiError({ code: "FORBIDDEN", status: 403, message: "x" }), "Akses ditolak"],
    [
      new ApiError({ code: "NOT_FOUND", status: 404, message: "Data tidak ditemukan." }),
      "Data tidak ditemukan",
    ],
    [
      new ApiError({ code: "MAINTENANCE", status: 503, message: "Pemeliharaan." }),
      "Layanan sedang dalam pemeliharaan",
    ],
    [
      new ApiError({ code: "RATE_LIMITED", status: 429, message: "Terlalu banyak.", retryAfterSeconds: 30 }),
      "Terlalu banyak permintaan",
    ],
    [
      new ApiError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Terjadi kesalahan.",
        requestId: "req-1",
      }),
      "Data gagal dimuat",
    ],
  ])("%s", async (error, title) => {
    const onRetry = vi.fn();
    render(<ErrorState error={error} onRetry={onRetry} />);
    expect(screen.getByText(title)).toBeInTheDocument();
    if (error.code === "INTERNAL_ERROR")
      expect(screen.getByText("Kode referensi: req-1")).toBeInTheDocument();
    if (error.code === "RATE_LIMITED") expect(screen.getByText(/dalam 30 detik/)).toBeInTheDocument();
    const retry = screen.queryByRole("button", { name: "Coba lagi" });
    if (retry) {
      await userEvent.setup().click(retry);
      expect(onRetry).toHaveBeenCalled();
    }
  });
});

describe("Toast", () => {
  it("wadah live selalu ada: galat ke aria-live assertive, sukses ke polite; dapat ditutup; pesan kembar tidak ditumpuk", async () => {
    const user = userEvent.setup();
    function Harness() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.error("Gagal menyimpan.")}>
            Galat
          </button>
          <button type="button" onClick={() => toast.success("Tersimpan.")}>
            Sukses
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    // Wadah live sudah terpasang (kosong) SEBELUM toast pertama agar penambahan isi pasti diumumkan.
    const region = screen.getByRole("region", { name: "Notifikasi" });
    const assertive = region.querySelector('[aria-live="assertive"]')!;
    const polite = region.querySelector('[aria-live="polite"]')!;
    expect(assertive).toBeEmptyDOMElement();
    expect(polite).toBeEmptyDOMElement();

    await user.click(screen.getByRole("button", { name: "Galat" }));
    await user.click(screen.getByRole("button", { name: "Galat" }));
    await user.click(screen.getByRole("button", { name: "Sukses" }));
    expect(toasts("error")).toHaveLength(1);
    expect(assertive).toContainElement(toasts("error")[0]!);
    expect(toasts("error")[0]).toHaveTextContent("Gagal: Gagal menyimpan.");
    expect(polite).toContainElement(toasts("success")[0]!);
    expect(toasts("success")[0]).toHaveTextContent("Berhasil: Tersimpan.");
    await user.click(within(toasts("error")[0]!).getByRole("button", { name: "Tutup notifikasi" }));
    expect(toasts("error")).toHaveLength(0);
    expect(toasts("success")).toHaveLength(1);
  });

  it("toast hilang otomatis setelah durasinya", async () => {
    vi.useFakeTimers();
    try {
      function Harness() {
        const toast = useToast();
        return (
          <button type="button" onClick={() => toast.success("Tersimpan.")}>
            Sukses
          </button>
        );
      }
      render(
        <ToastProvider>
          <Harness />
        </ToastProvider>,
      );
      act(() => screen.getByRole("button", { name: "Sukses" }).click());
      expect(screen.getByText("Tersimpan.")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(5_100));
      expect(screen.queryByText("Tersimpan.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PermissionGate (AC F15-1)", () => {
  it("menampilkan isi sesuai izin efektif; fallback Akses ditolak atau null", async () => {
    mockAuth.setAdmin({ role: "admin", permissions: ["payments.read"] });
    await signInViaApi();
    renderWithProviders(
      <>
        <PermissionGate anyOf={["payments.read"]}>
          <p>Antrean</p>
        </PermissionGate>
        <PermissionGate allOf={["payments.decide"]} fallback={null}>
          <button type="button">Setujui</button>
        </PermissionGate>
        <PermissionGate anyOf={["admins.manage"]}>
          <p>Admin</p>
        </PermissionGate>
      </>,
    );
    expect(await screen.findByText("Antrean")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Setujui" })).toBeNull();
    expect(screen.getByText("Akses ditolak")).toBeInTheDocument();
    expect(screen.queryByText("Admin")).toBeNull();
  });
});
