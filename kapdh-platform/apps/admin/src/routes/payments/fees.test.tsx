import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockPayments } from "../../api/mocks";
import { expectNoReauthDialog } from "../../test/governance";
import { findToast } from "../../test/utils";
import { IDS, openPayments, requestsTo } from "./testing";

const feePuts = () => requestsTo("PUT", "/admin/settings/fees");

function activeFees() {
  return screen.getByRole("region", { name: "Biaya aktif" });
}

function valueOf(container: HTMLElement, term: string) {
  return within(container).getByText(term, { selector: "dt" }).nextElementSibling;
}

describe("biaya pembayaran (F-03, D4, AC F15-3; server tiruan)", () => {
  it("AC F15-3, F03-5, ADR-025: ubah biaya tanpa reautentikasi, mengirim If-Match; versi baru hanya untuk tagihan baru", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "fees" });
    await screen.findByRole("region", { name: "Biaya aktif" });
    const card = activeFees();
    expect(within(card).getByText(/Versi 1, berlaku sejak/)).toBeInTheDocument();
    expect(valueOf(card, "Register alumni baru")).toHaveTextContent("Rp50.000");
    expect(valueOf(card, "Pembuatan KTA")).toHaveTextContent("Rp10.000");
    expect(valueOf(card, "Total iuran pendaftaran")).toHaveTextContent("Rp60.000");
    expect(valueOf(card, "Perpanjangan KTA per tahun")).toHaveTextContent("Rp10.000");
    expect(valueOf(card, "Ditetapkan oleh")).toHaveTextContent("Nilai awal go-live (D4)");
    expect(within(card).getByRole("note")).toHaveTextContent(
      "Perubahan biaya hanya berlaku untuk tagihan yang dibuat setelah disimpan",
    );

    const save = screen.getByRole("button", { name: "Simpan biaya baru" });
    expect(save).toBeDisabled();
    const registration = screen.getByRole("textbox", { name: /Register alumni baru/ });
    expect(registration).toHaveValue("50.000");
    await user.clear(registration);
    await user.type(registration, "55.000");
    expect(screen.getByText(/Total iuran pendaftaran baru/)).toHaveTextContent("Rp65.000");
    await user.type(screen.getByRole("textbox", { name: /Catatan perubahan/ }), "Keputusan rapat pengurus");
    await user.click(save);

    expect(
      await findToast("success", "Biaya versi 2 disimpan. Berlaku untuk tagihan yang dibuat mulai sekarang."),
    ).toBeInTheDocument();
    expectNoReauthDialog();
    const put = feePuts()[0];
    expect(put?.ifMatch).toBe("1");
    expect(put?.reauthToken).toBeNull();
    expect(put?.body).toEqual({
      registration_fee: "55000.00",
      card_fee: "10000.00",
      renewal_fee: "10000.00",
      reason: "Keputusan rapat pengurus",
    });
    await waitFor(() => expect(within(activeFees()).getByText(/Versi 2, berlaku sejak/)).toBeInTheDocument());
    expect(valueOf(activeFees(), "Total iuran pendaftaran")).toHaveTextContent("Rp65.000");
    expect(valueOf(activeFees(), "Ditetapkan oleh")).toHaveTextContent("Fikri");
    expect(screen.getByRole("button", { name: "Simpan biaya baru" })).toBeDisabled();

    // AC F03-5: tagihan yang sudah dibuat tetap memakai nominal dan versi biaya lamanya.
    expect(mockPayments.get(IDS.ahmad)).toMatchObject({ amount: "60000.00", settings_version: "1" });
    await user.click(screen.getByRole("tab", { name: /Verifikasi Pembayaran/ }));
    await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
    const panel = await screen.findByRole("article", { name: "Ahmad Islam" });
    expect(valueOf(panel, "Nominal tagihan")).toHaveTextContent(/^Rp60\.000/);
    expect(valueOf(panel, "Versi biaya")).toHaveTextContent(/^Versi 1/);
  });

  it("AC F15-4: biaya diubah admin lain → versi terbaru ditampilkan, simpan ditahan sampai dimuat ulang", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "fees" });
    const renewal = await screen.findByRole("textbox", { name: /Perpanjangan KTA per tahun/ });
    await user.clear(renewal);
    await user.type(renewal, "15.000");
    mockPayments.updateFeesAsOtherAdmin("50000.00", "10000.00", "12000.00");
    await user.click(screen.getByRole("button", { name: "Simpan biaya baru" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Biaya sudah diubah admin lain (versi 2). Perubahan Anda belum disimpan.",
    );
    expect(alert).toHaveTextContent("perpanjangan Rp12.000");
    expect(await findToast("error", "Biaya sudah diubah admin lain")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan biaya baru" })).toBeDisabled();
    // Isian admin tidak hilang dan server tidak ditimpa.
    expect(renewal).toHaveValue("15.000");
    expect(mockPayments.fees()).toMatchObject({ renewal_fee: "12000.00", version: "2" });
    expect(valueOf(activeFees(), "Perpanjangan KTA per tahun")).toHaveTextContent("Rp12.000");

    await user.click(within(alert).getByRole("button", { name: "Muat versi terbaru" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(renewal).toHaveValue("12.000");
    await user.clear(renewal);
    await user.type(renewal, "15.000");
    await user.click(screen.getByRole("button", { name: "Simpan biaya baru" }));
    expect(await findToast("success", "Biaya versi 3 disimpan.")).toBeInTheDocument();
    expectNoReauthDialog();
    expect(feePuts().map((r) => r.ifMatch)).toEqual(["1", "2"]);
    expect(feePuts().every((r) => r.reauthToken === null)).toBe(true);
    expect(mockPayments.fees()).toMatchObject({ renewal_fee: "15000.00", version: "3" });
  });

  it("nominal tidak valid ditolak di klien tanpa mengirim permintaan", async () => {
    const user = userEvent.setup();
    await openPayments(user, { tab: "fees" });
    const card = await screen.findByRole("textbox", { name: /Pembuatan KTA/ });
    await user.clear(card);
    await user.type(card, "sepuluh ribu");
    await user.click(screen.getByRole("button", { name: "Simpan biaya baru" }));
    await waitFor(() => expect(card).toHaveAccessibleDescription(/Nominal tidak valid/));
    expect(card).toHaveFocus();
    expectNoReauthDialog();
    expect(feePuts()).toHaveLength(0);
  });
});
