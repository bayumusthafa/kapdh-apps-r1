import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AASA_PATH,
  ASSETLINKS_PATH,
  MAX_FILE_BYTES,
  renderAasa,
  renderAppLinkFiles,
  renderAssetLinks,
  validateAppLinks,
} from "../../scripts/app-links.mjs";

/**
 * Berkas asosiasi tautan aplikasi (Android App Links, iOS Universal Links) dari apps/web/app-links.json:
 * scripts/app-links.mjs (validasi dan render), scripts/write-app-links.mjs (pasca-build) dan konsistensi dengan
 * identitas aplikasi di kapdh-mobile.
 */
const WEB = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const WRITER = join(WEB, "scripts", "write-app-links.mjs");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** Nilai uji yang jelas palsu tetapi berbentuk sah: SHA-256 dari teks biasa, bukan sertifikat. */
function fakeFingerprint(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").toUpperCase().match(/../g)!.join(":");
}
const FP_1 = fakeFingerprint("bukan-sertifikat-uji-1");
const FP_2 = fakeFingerprint("bukan-sertifikat-uji-2");
const TEAM_ID = "K4PDHUJI01";

const EMPTY = {
  $comment: "uji",
  android: { package_name: "id.or.kapdh.app", sha256_cert_fingerprints: [] as string[] },
  ios: { app_id_prefix: null as string | null, bundle_id: "id.or.kapdh.app" },
  paths: ["/app", "/app/*"],
};
const SAMPLE = {
  ...EMPTY,
  android: { ...EMPTY.android, sha256_cert_fingerprints: [FP_1, FP_2] },
  ios: { ...EMPTY.ios, app_id_prefix: TEAM_ID },
};

type Config = typeof EMPTY;
const withFingerprints = (fingerprints: unknown[]) => ({
  ...EMPTY,
  android: { ...EMPTY.android, sha256_cert_fingerprints: fingerprints },
});
const withTeamId = (prefix: unknown) => ({ ...EMPTY, ios: { ...EMPTY.ios, app_id_prefix: prefix } });
const withPaths = (paths: unknown) => ({ ...EMPTY, paths });

describe("app-links.mjs: render berkas asosiasi", () => {
  it("merender assetlinks.json dan apple-app-site-association dari konfigurasi contoh", () => {
    expect(renderAssetLinks(SAMPLE)).toBe(
      '[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app",' +
        `"package_name":"id.or.kapdh.app","sha256_cert_fingerprints":["${FP_1}","${FP_2}"]}}]`,
    );
    expect(renderAasa(SAMPLE)).toBe(
      `{"applinks":{"details":[{"appIDs":["${TEAM_ID}.id.or.kapdh.app"],` +
        '"components":[{"/":"/app"},{"/":"/app/*"}]}]}}',
    );
    const files = renderAppLinkFiles(SAMPLE);
    expect([...files.keys()]).toEqual([ASSETLINKS_PATH, AASA_PATH]);
    expect(ASSETLINKS_PATH).toBe(".well-known/assetlinks.json");
    expect(AASA_PATH).toBe(".well-known/apple-app-site-association");
    for (const body of files.values()) {
      expect(body).toBe(JSON.stringify(JSON.parse(body)));
      expect(body.charCodeAt(0)).not.toBe(0xfeff);
    }
  });

  it("konfigurasi kosong tidak menerbitkan berkas apa pun; tiap platform terbit hanya bila nilainya terisi", () => {
    expect(validateAppLinks(EMPTY)).toEqual([]);
    expect(renderAssetLinks(EMPTY)).toBeNull();
    expect(renderAasa(EMPTY)).toBeNull();
    expect(renderAppLinkFiles(EMPTY).size).toBe(0);
    expect([...renderAppLinkFiles(withFingerprints([FP_1])).keys()]).toEqual([ASSETLINKS_PATH]);
    expect([...renderAppLinkFiles(withTeamId(TEAM_ID)).keys()]).toEqual([AASA_PATH]);
  });

  it("render menolak konfigurasi tidak sah dan berkas yang mencapai batas 128 KB", () => {
    expect(() => renderAppLinkFiles(withTeamId("ABCDE12345"))).toThrow(/tidak sah/);
    const paths = ["/app", ...Array.from({ length: 6000 }, (_, i) => `/app/rute-uji-${i}/*`)];
    expect(validateAppLinks({ ...withTeamId(TEAM_ID), paths })).toEqual([]);
    expect(() => renderAppLinkFiles({ ...withTeamId(TEAM_ID), paths })).toThrow(
      new RegExp(`batas ${MAX_FILE_BYTES} byte`),
    );
  });
});

describe("app-links.mjs: validasi (nilai tidak sah menggagalkan build)", () => {
  it("menolak sidik sertifikat yang salah bentuk, duplikat, atau placeholder", () => {
    const bad = [
      FP_1.toLowerCase(),
      FP_1.replace(/:/g, ""),
      FP_1.slice(3),
      `${FP_1}:00`,
      FP_1.replace(/:/g, " "),
      Array(32).fill("00").join(":"),
      Array(32).fill("AA").join(":"),
      Array.from({ length: 32 }, (_, i) => i.toString(16).toUpperCase().padStart(2, "0")).join(":"),
      Array.from({ length: 32 }, (_, i) => (255 - i).toString(16).toUpperCase()).join(":"),
      Array(16).fill("AB:CD").join(":"),
      // Contoh di panduan App Links developer.android.com.
      "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5",
      42,
    ];
    for (const value of bad) {
      expect(validateAppLinks(withFingerprints([value])), String(value)).toEqual([
        expect.stringMatching(/^android\.sha256_cert_fingerprints\[0\]: /),
      ]);
    }
    expect(validateAppLinks(withFingerprints([FP_1, FP_1]))).toEqual([
      "android.sha256_cert_fingerprints[1]: duplikat",
    ]);
    expect(validateAppLinks(withFingerprints([FP_1, FP_2]))).toEqual([]);
    expect(
      validateAppLinks({ ...EMPTY, android: { ...EMPTY.android, sha256_cert_fingerprints: FP_1 } }),
    ).toEqual([expect.stringMatching(/^android\.sha256_cert_fingerprints: wajib daftar/)]);
  });

  it("menolak Team ID Apple yang salah bentuk atau placeholder", () => {
    const bad = [
      "K4PDHUJI0",
      "K4PDHUJI012",
      "k4pdhuji01",
      "K4PDH-JI01",
      "",
      "AAAAAAAAAA",
      "0000000000",
      "ABCDEFGHIJ",
      "0123456789",
      "1234567890",
      "ABCDE12345",
      "TEAMID1234",
      "K4XXXXUJ01",
      1234567890,
      undefined,
    ];
    for (const value of bad) {
      expect(validateAppLinks(withTeamId(value)), String(value)).toEqual([
        expect.stringMatching(/^ios\.app_id_prefix: /),
      ]);
    }
    expect(validateAppLinks(withTeamId(TEAM_ID))).toEqual([]);
    expect(validateAppLinks(withTeamId(null))).toEqual([]);
  });

  it("menolak nama paket Android dan bundle ID iOS yang bukan reverse-DNS", () => {
    for (const value of [
      "kapdh",
      "Id.Or.Kapdh.App",
      "id..app",
      "id.or.kapdh.app.",
      "1d.or.kapdh",
      "id.or-kapdh",
      "",
    ]) {
      expect(
        validateAppLinks({ ...EMPTY, android: { ...EMPTY.android, package_name: value } }),
        value,
      ).toEqual([expect.stringMatching(/^android\.package_name: /)]);
    }
    for (const value of ["kapdh", "id.or kapdh", "id.or.kapdh.app/", "id.or.kapdh_app", "", null]) {
      expect(validateAppLinks({ ...EMPTY, ios: { ...EMPTY.ios, bundle_id: value } }), String(value)).toEqual([
        expect.stringMatching(/^ios\.bundle_id: /),
      ]);
    }
  });

  it('paths hanya "/app" dan turunan "/app/..." (bukan /kta, /apply, segmen titik atau wildcard di tengah)', () => {
    for (const value of [
      "/kta",
      "/kta/*",
      "/apply",
      "/apps/*",
      "/",
      "*",
      "app",
      "/app/",
      "/app//x",
      "/app/../kta",
      "/app/./x",
      "/app/*/x",
      "/app/x?y",
      "/app/x y",
      "/APP",
    ]) {
      expect(validateAppLinks(withPaths(["/app", value])), value).toEqual([
        expect.stringMatching(/^paths\[1\] /),
      ]);
    }
    expect(validateAppLinks(withPaths(["/app", "/app"]))).toEqual(['paths[1] "/app": duplikat']);
    expect(validateAppLinks(withPaths([]))).toEqual([expect.stringMatching(/^paths: /)]);
    expect(validateAppLinks(withPaths("/app"))).toEqual([expect.stringMatching(/^paths: /)]);
    expect(validateAppLinks(withPaths(["/app", "/app/*", "/app/payments", "/app/payments/*"]))).toEqual([]);
  });

  it("menolak kunci tidak dikenal (salah ketik) dan bentuk yang salah", () => {
    expect(validateAppLinks(null)).toEqual(["app-links.json harus objek JSON"]);
    expect(validateAppLinks([EMPTY])).toEqual(["app-links.json harus objek JSON"]);
    expect(validateAppLinks({ ...EMPTY, team_id: TEAM_ID })).toEqual(["team_id: kunci tidak dikenal"]);
    expect(
      validateAppLinks({ ...EMPTY, android: { ...EMPTY.android, sha256_cert_fingerprint: [FP_1] } }),
    ).toEqual(["android.sha256_cert_fingerprint: kunci tidak dikenal"]);
    expect(validateAppLinks({ ...EMPTY, ios: { ...EMPTY.ios, team_id: TEAM_ID } })).toEqual([
      "ios.team_id: kunci tidak dikenal",
    ]);
    expect(validateAppLinks({ ...EMPTY, android: null, ios: [] })).toEqual([
      expect.stringMatching(/^android: /),
      expect.stringMatching(/^ios: /),
    ]);
    expect(validateAppLinks({ ...EMPTY, $comment: 1 })).toEqual(["$comment: harus teks"]);
  });
});

describe("write-app-links.mjs (gerbang pasca-build)", () => {
  let dir: string;
  let dist: string;
  const run = (config: unknown) => {
    const path = join(dir, "app-links.json");
    writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
    return spawnSync(process.execPath, [WRITER, "--config", path, "--dist", dist], { encoding: "utf8" });
  };
  const wellKnown = (path = "") => join(dist, ".well-known", path);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kapdh-app-links-"));
    dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("menulis kedua berkas persis hasil render (UTF-8 tanpa BOM) lalu menghapusnya saat konfigurasi kosong", () => {
    const written = run(SAMPLE);
    expect(written.status, written.stderr).toBe(0);
    for (const [path, body] of renderAppLinkFiles(SAMPLE)) {
      const bytes = readFileSync(join(dist, path));
      expect(bytes.toString("utf8")).toBe(body);
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    }

    const cleared = run(EMPTY);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(existsSync(wellKnown())).toBe(false);
    expect(cleared.stdout).toContain("tidak diterbitkan (404)");
  });

  it("hanya Android: AASA lama dihapus dan tidak ditulis ulang", () => {
    expect(run(SAMPLE).status).toBe(0);
    const android = run(withFingerprints([FP_1]));
    expect(android.status, android.stderr).toBe(0);
    expect(existsSync(wellKnown("assetlinks.json"))).toBe(true);
    expect(existsSync(wellKnown("apple-app-site-association"))).toBe(false);
  });

  it("konfigurasi tidak sah atau bukan JSON menggagalkan build tanpa menulis berkas", () => {
    const placeholder = run(withFingerprints([Array(32).fill("00").join(":")]));
    expect(placeholder.status).toBe(1);
    expect(placeholder.stderr).toContain("android.sha256_cert_fingerprints[0]: nilai contoh/placeholder");
    expect(placeholder.stderr).toContain("Gerbang tautan aplikasi gagal");
    expect(existsSync(wellKnown())).toBe(false);

    const broken = run("{ bukan json");
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("app-links.json bukan JSON");
  });

  it("berkas lain di dist/.well-known/ (tidak pernah dilayani nginx) dan dist kosong menggagalkan build", () => {
    mkdirSync(wellKnown());
    writeFileSync(wellKnown("security.txt"), "Contact: mailto:bantuan@kapdh.or.id\n");
    const stray = run(EMPTY);
    expect(stray.status).toBe(1);
    expect(stray.stderr).toContain("dist/.well-known/security.txt");

    rmSync(dist, { recursive: true, force: true });
    const empty = run(EMPTY);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("dist kosong");
  });
});

/** PRODUCT_BUNDLE_IDENTIFIER setiap konfigurasi build target aplikasi Runner di project.pbxproj. */
function runnerBundleIds(pbxproj: string): string[] {
  const objects = new Map<string, string>();
  for (const m of pbxproj.matchAll(/^\t\t([0-9A-F]{24})(?: \/\* .*? \*\/)? = \{\n([\s\S]*?)\n\t\t\};$/gm)) {
    objects.set(m[1]!, m[2]!);
  }
  const target = [...objects.values()].find(
    (body) => /\bisa = PBXNativeTarget;/.test(body) && /^\t\t\tname = Runner;$/m.test(body),
  );
  const listId = target && /buildConfigurationList = ([0-9A-F]{24})/.exec(target)?.[1];
  const list = listId ? objects.get(listId) : undefined;
  if (!list) throw new Error("target Runner tidak ditemukan di project.pbxproj");
  return [...list.matchAll(/^\t\t\t\t([0-9A-F]{24})/gm)].map(
    (m) => /PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/.exec(objects.get(m[1]!) ?? "")?.[1] ?? "(tidak ada)",
  );
}

describe("konsistensi app-links.json dengan kapdh-mobile", () => {
  const committed = JSON.parse(readFileSync(join(WEB, "app-links.json"), "utf8")) as Config;

  it("app-links.json yang di-commit sah", () => {
    expect(validateAppLinks(committed)).toEqual([]);
  });

  it("package_name sama dengan applicationId Android", () => {
    const gradle = read("kapdh-mobile/android/app/build.gradle.kts");
    const ids = [...gradle.matchAll(/^\s*applicationId\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    expect(ids).toEqual([committed.android.package_name]);
  });

  it("bundle_id sama dengan PRODUCT_BUNDLE_IDENTIFIER target Runner iOS di semua konfigurasi build", () => {
    const ids = runnerBundleIds(read("kapdh-mobile/ios/Runner.xcodeproj/project.pbxproj"));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([committed.ios.bundle_id]));
  });

  it("components AASA sama dengan intent-filter App Links (path /app + pathPrefix /app/)", () => {
    const manifest = read("kapdh-mobile/android/app/src/main/AndroidManifest.xml").replace(
      /<!--[\s\S]*?-->/g,
      "",
    );
    const verified = [...manifest.matchAll(/<intent-filter\b([^>]*)>([\s\S]*?)<\/intent-filter>/g)].filter(
      (m) => /android:autoVerify="true"/.test(m[1]!),
    );
    expect(verified).toHaveLength(1);
    const body = verified[0]![2]!;
    const attr = (name: string) =>
      [...body.matchAll(new RegExp(`android:${name}="([^"]*)"`, "g"))].map((m) => m[1]!);
    expect(attr("scheme")).toEqual(["https"]);
    expect(attr("host")).toEqual(["kapdh.or.id"]);
    for (const other of ["pathPattern", "pathAdvancedPattern", "pathSuffix"]) expect(attr(other)).toEqual([]);
    expect(attr("path")).toEqual(["/app"]);
    expect(attr("pathPrefix")).toEqual(["/app/"]);
    const fromManifest = [...attr("path"), ...attr("pathPrefix").map((prefix) => `${prefix}*`)];

    expect([...committed.paths].sort()).toEqual([...fromManifest].sort());
    const aasa = JSON.parse(renderAasa({ ...committed, ios: { ...committed.ios, app_id_prefix: TEAM_ID } })!);
    const components = (aasa.applinks.details[0].components as { "/": string }[]).map((c) => c["/"]);
    expect(components.sort()).toEqual([...fromManifest].sort());
  });
});
