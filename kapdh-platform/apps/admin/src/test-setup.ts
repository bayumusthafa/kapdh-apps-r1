import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetMockServer } from "./api/mocks";
import { setAccessToken } from "./api/client";

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
