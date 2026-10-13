import { it } from "vitest";
import { DeletionDisclosureService } from "../../src/modules/account/deletion-disclosure.service.js";
import { createAlumni } from "../support/factories.js";
import { createTestApp } from "../support/test-app.js";

it("debug", async () => {
  const t = await createTestApp();
  const member = await createAlumni(t, { status: "verified" });
  try {
    await t.app.get(DeletionDisclosureService).compute(t.db, { id: member.userId, status: "active" });
  } catch (e) {
    console.log("ERR", e, (e as { cause?: unknown }).cause);
  }
  await t.app.close();
});
