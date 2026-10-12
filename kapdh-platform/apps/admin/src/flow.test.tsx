import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setAccessToken } from "./api/client";
import { MOCK_CREDENTIALS, resetMockSession } from "./api/mock";
import { AuthProvider } from "./auth/session";
import { createAppRouter } from "./router";

function renderApp(start: "/login" | "/payments" = "/login") {
  const router = createAppRouter();
  void router.navigate({ to: start });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetMockSession();
  setAccessToken(null);
});

async function signIn(user: ReturnType<typeof userEvent.setup>, code: string = MOCK_CREDENTIALS.totp) {
  await user.type(await screen.findByLabelText("Email"), MOCK_CREDENTIALS.email);
  await user.type(screen.getByLabelText("Sandi"), MOCK_CREDENTIALS.password);
  await user.click(screen.getByRole("button", { name: "Masuk" }));
  if (code === MOCK_CREDENTIALS.backupCode) {
    await user.click(await screen.findByRole("button", { name: /Pakai backup code/ }));
    await user.type(await screen.findByLabelText("Backup code"), code);
  } else {
    await user.type(await screen.findByLabelText("Kode autentikator"), code);
  }
  await user.click(screen.getByRole("button", { name: "Verifikasi" }));
  return screen.findByRole("navigation", { name: "Menu admin" });
}

describe("alur admin (dengan server tiruan)", () => {
  it("memulihkan sesi dari cookie refresh setelah halaman dimuat ulang", async () => {
    const user = userEvent.setup();
    const first = renderApp();
    await signIn(user);
    first.unmount();
    setAccessToken(null); // access token di memori hilang saat reload

    renderApp("/payments");
    expect(await screen.findByRole("navigation", { name: "Menu admin" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Sandi")).toBeNull();
  });

  it("keluar mencabut sesi sehingga reload kembali ke halaman login", async () => {
    const user = userEvent.setup();
    const first = renderApp();
    await signIn(user);
    await user.click(screen.getByRole("button", { name: "Keluar" }));
    expect(await screen.findByLabelText("Sandi")).toBeInTheDocument();
    first.unmount();

    renderApp("/payments");
    expect(await screen.findByLabelText("Sandi")).toBeInTheDocument();
  });

  it("backup code bisa dipakai bila autentikator tidak tersedia", async () => {
    const user = userEvent.setup();
    renderApp();
    expect(await signIn(user, MOCK_CREDENTIALS.backupCode)).toBeInTheDocument();
  });

  it("login, TOTP, lalu menyetujui pembayaran setelah konfirmasi dana", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Email"), MOCK_CREDENTIALS.email);
    await user.type(screen.getByLabelText("Sandi"), MOCK_CREDENTIALS.password);
    await user.click(screen.getByRole("button", { name: "Masuk" }));

    await user.type(await screen.findByLabelText("Kode autentikator"), MOCK_CREDENTIALS.totp);
    await user.click(screen.getByRole("button", { name: "Verifikasi" }));

    const nav = await screen.findByRole("navigation", { name: "Menu admin" });
    expect(within(nav).queryByText("Manajemen Admin")).toBeNull();
    await user.click(within(nav).getByText("Verifikasi Pembayaran"));

    await user.click(await screen.findByRole("button", { name: /Ahmad Islam/ }));
    const approve = await screen.findByRole("button", { name: "Setujui" });
    expect(approve).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(approve);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pembayaran disetujui."));
  });

  it("menolak login dengan sandi salah", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText("Email"), MOCK_CREDENTIALS.email);
    await user.type(screen.getByLabelText("Sandi"), "salah");
    await user.click(screen.getByRole("button", { name: "Masuk" }));
    expect(await screen.findByText("Email atau sandi salah.")).toBeInTheDocument();
  });
});
