import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_PAGES_LIMIT } from "../../src/modules/content/public-pages.controller.js";
import { httpClient } from "../support/http.js";
import { createTestApp, type TestApp } from "../support/test-app.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.app.close();
});

describe("scratch review 3", () => {
  it("cache-control on error responses of public pages", async () => {
    const api = httpClient(t.app);
    const notFound = await api.get("/public/pages/belum-ada-halaman");
    console.log("H404", notFound.statusCode, JSON.stringify(notFound.headers["cache-control"]));
    const tooLong = await api.get(`/public/pages/${"a".repeat(300)}`);
    console.log("H400", tooLong.statusCode, JSON.stringify(tooLong.headers["cache-control"]));
    let last = notFound;
    for (let i = 0; i < PUBLIC_PAGES_LIMIT + 2; i++) last = await api.get("/public/pages");
    console.log(
      "H429",
      last.statusCode,
      JSON.stringify(last.headers["cache-control"]),
      JSON.stringify(last.headers["retry-after"]),
    );
    const otherApi = await api.get("/public/config");
    console.log("HCFG", otherApi.statusCode, JSON.stringify(otherApi.headers["cache-control"]));
    expect(true).toBe(true);
  });
});
