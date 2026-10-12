import { beforeEach } from "vitest";
import { resetRateLimits } from "./test-app.js";

/**
 * Dipasang lewat vitest setupFiles: setiap tes mulai dengan rate limit kosong. Semua request uji berasal dari IP yang
 * sama (127.0.0.1), sehingga tanpa reset batas per IP (login, OTP) akan bocor antar tes.
 */
beforeEach(() => {
  resetRateLimits();
});
