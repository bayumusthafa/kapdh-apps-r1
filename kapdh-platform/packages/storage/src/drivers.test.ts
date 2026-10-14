import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSafeObjectKey,
  createStorageDriver,
  destroyStorageDriver,
  FallbackReadDriver,
  hashObject,
  LocalDriver,
  MemoryDriver,
  readAll,
  S3Driver,
  sha256Hex,
  StorageConfigError,
  type StorageDriver,
  StorageObjectNotFoundError,
  transferObject,
} from "./index.js";
import { startFakeS3 } from "./test-support/fake-s3.js";

describe("assertSafeObjectKey (PRD 5.4)", () => {
  it("menerima key <purpose>/<yyyy>/<mm>/<uuid>", () => {
    expect(() =>
      assertSafeObjectKey("payment_proof/2026/10/0192f0d2-7c1e-7d5a-9a51-1f1c2b3d4e5f"),
    ).not.toThrow();
  });

  it.each(["", "/awal", "akhir/", "../etc/passwd", "a/../b", "Nama Orang.jpg", "a//b", "a\\b", ".tmp/x"])(
    "menolak key tidak aman %j",
    (key) => {
      expect(() => assertSafeObjectKey(key)).toThrow();
    },
  );
});

let localRoot: string;
const fakeS3 = await startFakeS3();
const s3Config = {
  bucket: "kapdh-uji",
  region: "ap-southeast-1",
  endpoint: fakeS3.url,
  forcePathStyle: true,
  accessKeyId: "AKIAUJI",
  secretAccessKey: "rahasia-uji-bukan-asli",
};

beforeAll(async () => {
  localRoot = await mkdtemp(join(tmpdir(), "kapdh-storage-"));
});
afterAll(async () => {
  await rm(localRoot, { recursive: true, force: true });
  await fakeS3.close();
});

const drivers: [string, () => StorageDriver][] = [
  ["MemoryDriver", () => new MemoryDriver()],
  ["LocalDriver", () => new LocalDriver(join(localRoot, "data"))],
  ["S3Driver (server S3 tiruan, path-style)", () => new S3Driver(s3Config)],
];

describe.each(drivers)("kontrak StorageDriver: %s", (_name, make) => {
  const key = (suffix: string) => `avatar/2026/10/${suffix}`;

  it("put buffer lalu get, stat, exists, copy, delete idempoten", async () => {
    const driver = make();
    const body = Buffer.from("isi berkas uji");
    const info = await driver.put(key("a1"), body, { contentType: "image/jpeg" });
    expect(info).toEqual({
      key: key("a1"),
      bytes: body.byteLength,
      contentType: "image/jpeg",
      sha256: sha256Hex(body),
    });
    expect((await readAll(await driver.get(key("a1")))).toString()).toBe("isi berkas uji");
    expect(await driver.exists(key("a1"))).toBe(true);
    expect(await driver.stat(key("a1"))).toMatchObject({ key: key("a1"), bytes: body.byteLength });

    const copied = await driver.copy(key("a1"), key("a2"));
    expect(copied).toMatchObject({ key: key("a2"), bytes: body.byteLength, sha256: sha256Hex(body) });
    expect((await readAll(await driver.get(key("a2")))).toString()).toBe("isi berkas uji");

    await driver.delete(key("a1"));
    await driver.delete(key("a1"));
    expect(await driver.exists(key("a1"))).toBe(false);
    expect(await driver.stat(key("a1"))).toBeNull();
    await expect(driver.get(key("a1"))).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(driver.copy(key("a1"), key("a3"))).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("put stream menghitung sha256 dan jumlah byte tanpa menampung di pemanggil", async () => {
    const driver = make();
    const parts = ["baris,1\n", "baris,2\n", "baris,3\n"];
    const info = await driver.put(key("s1"), Readable.from(parts.map((p) => Buffer.from(p))), {
      contentType: "text/csv",
    });
    const all = Buffer.from(parts.join(""));
    expect(info).toMatchObject({ bytes: all.byteLength, sha256: sha256Hex(all) });
    expect(await hashObject(driver, key("s1"))).toEqual({ sha256: sha256Hex(all), bytes: all.byteLength });
  });

  it("menimpa key yang sama", async () => {
    const driver = make();
    await driver.put(key("o1"), Buffer.from("lama"), { contentType: "image/png" });
    await driver.put(key("o1"), Buffer.from("baru"), { contentType: "image/png" });
    expect((await readAll(await driver.get(key("o1")))).toString()).toBe("baru");
  });

  it("menolak key tidak aman sebelum menyentuh storage", async () => {
    const driver = make();
    await expect(driver.put("../luar", Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow(
      "Object key penyimpanan tidak valid",
    );
    await expect(driver.get("a/../../b")).rejects.toThrow();
  });
});

describe("LocalDriver (PRD 2.5: berkas privat tidak dilayani dari folder publik)", () => {
  it("menolak root relatif dan root di dalam folder publik", () => {
    expect(() => new LocalDriver("data/files")).toThrow(StorageConfigError);
    expect(() => new LocalDriver(join(localRoot, "apps", "web", "public", "files"))).toThrow(/folder publik/);
    expect(() => new LocalDriver(join(localRoot, "static"))).toThrow(StorageConfigError);
  });

  it("penulisan atomik: berkas sementara tidak tersisa, isi akhir utuh, izin 0600 di POSIX", async () => {
    const root = join(localRoot, "atomik");
    const driver = new LocalDriver(root);
    await driver.put("payment_proof/2026/10/x1", Buffer.alloc(256 * 1024, 7), { contentType: "image/png" });
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
    const file = join(root, "payment_proof", "2026", "10", "x1");
    expect((await readFile(file)).equals(Buffer.alloc(256 * 1024, 7))).toBe(true);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("stream sumber yang gagal tidak meninggalkan objek maupun berkas sementara", async () => {
    const root = join(localRoot, "gagal");
    const driver = new LocalDriver(root);
    const broken = new Readable({
      read() {
        this.push(Buffer.from("sebagian"));
        this.destroy(new Error("koneksi putus"));
      },
    });
    await expect(driver.put("avatar/2026/10/rusak", broken, { contentType: "image/png" })).rejects.toThrow(
      "koneksi putus",
    );
    expect(await driver.exists("avatar/2026/10/rusak")).toBe(false);
    expect(await readdir(join(root, ".tmp"))).toEqual([]);
  });
});

describe("transferObject (perpindahan storage PRD 5.4)", () => {
  it("menyalin antardriver dan mencocokkan checksum", async () => {
    const source = new MemoryDriver();
    const target = new LocalDriver(join(localRoot, "migrasi"));
    const body = Buffer.from("bukti bayar");
    const stored = await source.put("payment_proof/2026/10/m1", body, { contentType: "application/pdf" });
    await expect(
      transferObject(source, target, stored.key, {
        contentType: "application/pdf",
        expectedSha256: stored.sha256,
      }),
    ).resolves.toMatchObject({ sha256: stored.sha256 });
    expect((await readAll(await target.get(stored.key))).equals(body)).toBe(true);
  });

  it("checksum berbeda membatalkan salinan", async () => {
    const source = new MemoryDriver();
    const target = new MemoryDriver();
    await source.put("avatar/2026/10/m2", Buffer.from("isi"), { contentType: "image/png" });
    await expect(
      transferObject(source, target, "avatar/2026/10/m2", {
        contentType: "image/png",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/Checksum/);
    expect(await target.exists("avatar/2026/10/m2")).toBe(false);
  });
});

describe("MemoryDriver.failNext (injeksi kegagalan uji)", () => {
  it("operasi berikutnya gagal sekali lalu pulih", async () => {
    const driver = new MemoryDriver();
    driver.failNext("put");
    await expect(
      driver.put("avatar/2026/10/f", Buffer.from("x"), { contentType: "image/png" }),
    ).rejects.toThrow();
    await expect(
      driver.put("avatar/2026/10/f", Buffer.from("x"), { contentType: "image/png" }),
    ).resolves.toBeTruthy();
  });
});

describe("createStorageDriver", () => {
  const base = { STORAGE_LOCAL_ROOT: "/data/files", S3_FORCE_PATH_STYLE: false } as const;
  it("local dan s3 sesuai STORAGE_DRIVER", () => {
    expect(createStorageDriver({ ...base, STORAGE_DRIVER: "local" })).toBeInstanceOf(LocalDriver);
    expect(
      createStorageDriver({
        ...base,
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "b",
        S3_REGION: "r",
        S3_ACCESS_KEY_ID: "a",
        S3_SECRET_ACCESS_KEY: "s",
      }),
    ).toBeInstanceOf(S3Driver);
  });
  it("STORAGE_LOCAL_ROOT relatif (.env.example) diselesaikan dari cwd, sama untuk API/worker/CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kapdh-cwd-"));
    try {
      const driver = createStorageDriver(
        { ...base, STORAGE_DRIVER: "local", STORAGE_LOCAL_ROOT: "./.data/files" },
        { cwd },
      );
      await driver.put("avatar/2026/10/obj-relatif", Buffer.from("isi"), { contentType: "text/plain" });
      expect((await stat(join(cwd, ".data", "files", "avatar", "2026", "10", "obj-relatif"))).size).toBe(3);
      // Folder publik tetap ditolak walau relatif.
      expect(() =>
        createStorageDriver(
          { ...base, STORAGE_DRIVER: "local", STORAGE_LOCAL_ROOT: "./public/files" },
          { cwd },
        ),
      ).toThrow(StorageConfigError);
      expect(() =>
        createStorageDriver({ ...base, STORAGE_DRIVER: "local", STORAGE_LOCAL_ROOT: "  " }, { cwd }),
      ).toThrow(StorageConfigError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("s3 tanpa kredensial ditolak", () => {
    expect(() => createStorageDriver({ ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(
      StorageConfigError,
    );
  });
});

describe("S3Driver ke server S3 tiruan", () => {
  it("objek tersimpan di bucket dengan content-type hasil deteksi", async () => {
    const driver = new S3Driver(s3Config);
    await driver.put("banner_image/2026/10/b1", Buffer.from("png"), { contentType: "image/png" });
    expect(fakeS3.objects.get("kapdh-uji/banner_image/2026/10/b1")).toMatchObject({
      contentType: "image/png",
    });
    expect(await driver.stat("banner_image/2026/10/b1")).toMatchObject({
      contentType: "image/png",
      bytes: 3,
    });
  });

  it("AC F14-6, D5-07: contentMd5 mengirim Content-MD5 yang diwajibkan bucket Object Lock; body stream ditolak", async () => {
    const locked = { ...s3Config, bucket: "bucket-terkunci" };
    await expect(
      new S3Driver(locked).put("account-deletions/2026/10/a.json", Buffer.from("{}"), {
        contentType: "application/json",
      }),
    ).rejects.toThrow();
    const driver = new S3Driver({ ...locked, contentMd5: true });
    const stored = await driver.put("account-deletions/2026/10/a.json", Buffer.from("{}"), {
      contentType: "application/json",
    });
    expect(stored).toMatchObject({ bytes: 2, sha256: sha256Hex(Buffer.from("{}")) });
    expect(fakeS3.objects.get("bucket-terkunci/account-deletions/2026/10/a.json")?.body.toString()).toBe(
      "{}",
    );
    await expect(
      driver.put("account-deletions/2026/10/b.json", Readable.from([Buffer.from("{}")]), {
        contentType: "application/json",
      }),
    ).rejects.toBeInstanceOf(StorageConfigError);
  });

  it("galat selain 404 diteruskan (bukan dianggap tidak ada)", async () => {
    const driver = new S3Driver({ ...s3Config, bucket: "bucket-rusak" });
    await expect(driver.stat("avatar/2026/10/x")).rejects.toThrow();
  });
});

describe("FallbackReadDriver (perpindahan local -> S3, PRD 5.4 fallback read)", () => {
  const key = "payment_proof/2026/10/0192f0d2-7c1e-7d5a-9a51-000000000001";
  const setup = async () => {
    const primary = new MemoryDriver();
    const fallback = new MemoryDriver();
    await fallback.put(key, Buffer.from("bukti-lama"), { contentType: "image/jpeg" });
    return { primary, fallback, driver: new FallbackReadDriver(primary, fallback) };
  };

  it("objek yang belum tersalin dibaca dari lokasi lama; tulisan baru hanya ke driver utama", async () => {
    const { primary, fallback, driver } = await setup();
    expect((await readAll(await driver.get(key))).toString()).toBe("bukti-lama");
    expect(await driver.exists(key)).toBe(true);
    expect(await driver.stat(key)).toMatchObject({ bytes: 10 });
    await driver.put("avatar/2026/10/baru", Buffer.from("baru"), { contentType: "image/png" });
    expect(primary.keys()).toEqual(["avatar/2026/10/baru"]);
    expect(fallback.keys()).toEqual([key]);
    expect(driver.name).toBe("memory");
  });

  it("objek yang sudah tersalin dibaca dari driver utama; tidak ada di keduanya -> StorageObjectNotFoundError", async () => {
    const { primary, driver } = await setup();
    await primary.put(key, Buffer.from("bukti-s3"), { contentType: "image/jpeg" });
    expect((await readAll(await driver.get(key))).toString()).toBe("bukti-s3");
    await expect(driver.get("avatar/2026/10/tidak-ada")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(await driver.stat("avatar/2026/10/tidak-ada")).toBeNull();
  });

  it("D2, AC F14-6: penghapusan menghapus di kedua lokasi sehingga berkas tidak hidup kembali dari salinan lama", async () => {
    const { primary, fallback, driver } = await setup();
    await primary.put(key, Buffer.from("bukti-s3"), { contentType: "image/jpeg" });
    await driver.delete(key);
    expect(primary.keys()).toEqual([]);
    expect(fallback.keys()).toEqual([]);
    expect(await driver.exists(key)).toBe(false);
  });

  it("copy dari objek yang hanya ada di lokasi lama ditulis ke driver utama", async () => {
    const { primary, driver } = await setup();
    const copied = await driver.copy(key, "audit_export/2026/10/salinan");
    expect(copied.sha256).toBe(sha256Hex(Buffer.from("bukti-lama")));
    expect(primary.contents("audit_export/2026/10/salinan")?.toString()).toBe("bukti-lama");
  });

  it("shutdown: destroyStorageDriver menutup klien S3 yang dibungkus FallbackReadDriver; driver tanpa sumber daya diabaikan", () => {
    const closed: string[] = [];
    const s3Like = Object.assign(new MemoryDriver(), { destroy: () => closed.push("utama") });
    const driver = new FallbackReadDriver(s3Like, new MemoryDriver());
    destroyStorageDriver(driver);
    expect(closed).toEqual(["utama"]);
    expect(() => destroyStorageDriver(new MemoryDriver())).not.toThrow();
    expect(() => destroyStorageDriver(null)).not.toThrow();
  });

  it("galat driver utama selain tidak-ada diteruskan (tidak diam-diam membaca salinan lama)", async () => {
    const { primary, driver } = await setup();
    primary.failNext("get");
    await expect(driver.get(key)).rejects.toThrow(/Kegagalan storage tiruan/);
  });

  it("createStorageDriver: s3 + STORAGE_FALLBACK_LOCAL_ROOT membungkus S3 dengan baca-cadangan disk lama", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kapdh-fallback-"));
    try {
      await new LocalDriver(join(cwd, "lama")).put(key, Buffer.from("isi-lama"), {
        contentType: "image/jpeg",
      });
      const driver = createStorageDriver(
        {
          STORAGE_DRIVER: "s3",
          STORAGE_LOCAL_ROOT: "/tidak-dipakai",
          S3_BUCKET: s3Config.bucket,
          S3_REGION: s3Config.region,
          S3_ENDPOINT: s3Config.endpoint,
          S3_ACCESS_KEY_ID: s3Config.accessKeyId,
          S3_SECRET_ACCESS_KEY: s3Config.secretAccessKey,
          S3_FORCE_PATH_STYLE: true,
          STORAGE_FALLBACK_LOCAL_ROOT: "./lama",
        },
        { cwd },
      );
      expect(driver).toBeInstanceOf(FallbackReadDriver);
      expect((await readAll(await driver.get(key))).toString()).toBe("isi-lama");
      await driver.put("avatar/2026/10/fallback-baru", Buffer.from("x"), { contentType: "image/png" });
      expect(fakeS3.objects.has(`${s3Config.bucket}/avatar/2026/10/fallback-baru`)).toBe(true);
      // Shutdown: klien S3 di dalam pembungkus ditutup (tanpa galat).
      expect(() => destroyStorageDriver(driver)).not.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
