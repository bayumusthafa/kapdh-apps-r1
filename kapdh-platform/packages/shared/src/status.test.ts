import { describe, expect, it } from "vitest";
import { routeForStatus } from "./status.js";

describe("routeForStatus", () => {
  it("memetakan setiap status ke rute awal", () => {
    expect(routeForStatus("pending_otp")).toBe("verify_otp");
    expect(routeForStatus("unverified")).toBe("onboarding_payment");
    expect(routeForStatus("expiring")).toBe("home");
    expect(routeForStatus("expired")).toBe("renewal");
    expect(routeForStatus("suspended")).toBe("restricted");
  });
});
