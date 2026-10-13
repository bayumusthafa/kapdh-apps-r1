import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetMockServer } from "./api/mocks";
import { setAccessToken } from "./api/client";

// Potongan kode area dimuat lazy dan ditransformasi saat pertama dipakai; di suite paralel pemuatan pertama bisa
// melebihi 1 detik bawaan findBy*/waitFor sehingga uji gagal acak. Batas 5 detik tetap jauh di bawah testTimeout.
configure({ asyncUtilTimeout: 5_000 });

// jsdom tidak mengimplementasikan scroll; router memanggilnya untuk pemulihan posisi gulir.
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

beforeEach(() => {
  resetMockServer();
  setAccessToken(null);
  try {
    window.localStorage.clear();
  } catch {
    // abaikan
  }
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});
