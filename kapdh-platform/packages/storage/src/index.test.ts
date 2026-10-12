import { describe, expect, it } from "vitest";
import { assertSafeObjectKey, MemoryStorage, sha256Hex, StorageObjectNotFoundError } from "./index.js";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("assertSafeObjectKey (PRD 5.4)", () => {
  it("menerima key bersegmen huruf kecil", () => {
    expect(() => assertSafeObjectKey("payment_proof/2026/10/0192f0d2-aaaa.pdf")).not.toThrow();
  });

  it.each(["", "/awal", "akhir/", "../etc/passwd", "a/../b", "Nama Orang.jpg", "a//b", "a\\b"])(
    "menolak key tidak aman %j",
    (key) => {
      expect(() => assertSafeObjectKey(key)).toThrow();
    },
  );
});

describe("MemoryStorage", () => {
  it("put, stat, read, copy, delete", async () => {
    const storage = new MemoryStorage();
    const body = Buffer.from("isi berkas");
    const info = await storage.put("avatar/a.jpg", body, { contentType: "image/jpeg" });
    expect(info).toEqual({ key: "avatar/a.jpg", bytes: body.byteLength, contentType: "image/jpeg", sha256: sha256Hex(body) });
    expect(await storage.stat("avatar/a.jpg")).toEqual(info);
    expect((await readAll(await storage.read("avatar/a.jpg"))).toString()).toBe("isi berkas");
    await storage.copy("avatar/a.jpg", "avatar/b.jpg");
    expect(storage.keys()).toEqual(["avatar/a.jpg", "avatar/b.jpg"]);
    await storage.delete("avatar/a.jpg");
    await storage.delete("avatar/a.jpg");
    expect(await storage.stat("avatar/a.jpg")).toBeNull();
    await expect(storage.read("avatar/a.jpg")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(await storage.signedReadUrl()).toBeNull();
  });
});
