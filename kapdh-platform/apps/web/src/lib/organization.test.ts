import { describe, expect, it } from "vitest";
import {
  ORGANIZATION,
  ORGANIZATION_ADDRESS_LINE,
  ORGANIZATION_SEAT_LINE,
  organizationJsonLd,
  serializeJsonLd,
} from "./organization";
import { DEFAULT_SUPPORT_EMAIL } from "../scripts/config";
import { OFFICIAL_EMAIL } from "./site";

const SITE = new URL("https://kapdh.or.id");
const SK_NUMBER = "AHU-0002732.AH.01.07.TAHUN 2023";

describe("ORGANIZATION (SK, akta pendirian, Anggaran Dasar)", () => {
  it("nama badan hukum persis seperti SK, tanpa kata Pondok", () => {
    expect(ORGANIZATION.legalName).toBe("Perkumpulan Keluarga Alumni Pesantren Darel Hikmah");
    expect(ORGANIZATION.name).toBe("Keluarga Alumni Pesantren Darel Hikmah");
    expect(ORGANIZATION.name.toUpperCase()).toBe("KELUARGA ALUMNI PESANTREN DAREL HIKMAH");
    expect(ORGANIZATION.legalName).not.toMatch(/pondok|ponpes/i);
    expect(ORGANIZATION.shortName).toBe("KAPDH");
    expect(ORGANIZATION.legalForm).toBe("Perkumpulan berbadan hukum");
  });

  it("nomor dan judul SK pengesahan persis", () => {
    expect(ORGANIZATION.sk.number).toBe(SK_NUMBER);
    expect(ORGANIZATION.sk.title).toBe(
      "Keputusan Menteri Hukum dan Hak Asasi Manusia Republik Indonesia Nomor AHU-0002732.AH.01.07.TAHUN 2023 " +
        "tentang Pengesahan Pendirian Perkumpulan Keluarga Alumni Pesantren Darel Hikmah",
    );
    expect(ORGANIZATION.sk.issuedAt).toBe("2023-04-11");
    expect(ORGANIZATION.sk.issuedLabel).toBe("11 April 2023");
    expect(ORGANIZATION.sk.shortLabel).toBe("SK Menteri Hukum dan HAM");
    expect(ORGANIZATION.sk.issuedPlace).toBe("Jakarta");
  });

  it("akta pendirian dan asas", () => {
    expect(ORGANIZATION.akta).toEqual({
      number: "01",
      date: "2023-03-27",
      dateLabel: "27 Maret 2023",
      notary: "Syarifah Murdalifah, S.H., M.Kn.",
      city: "Kota Pekanbaru",
    });
    expect(ORGANIZATION.principle).toBe("Pancasila dan Undang-Undang Dasar 1945");
  });

  it("alamat kedudukan (AD Pasal 1)", () => {
    expect(ORGANIZATION.address).toMatchObject({
      place: "Pondok Pesantren Darel Hikmah",
      streetAddress: "Jalan Manyar Sakti",
      kelurahan: "Simpang Baru",
      kecamatan: "Binawidya",
      city: "Kota Pekanbaru",
      province: "Riau",
      postalCode: "28293",
      country: "Indonesia",
    });
    expect(ORGANIZATION_ADDRESS_LINE).toBe(
      "Jalan Manyar Sakti, Kelurahan Simpang Baru, Kecamatan Binawidya, Kota Pekanbaru, Riau 28293",
    );
    expect(ORGANIZATION_SEAT_LINE).toBe(
      "Pondok Pesantren Darel Hikmah, Jalan Manyar Sakti, Kelurahan Simpang Baru, Kecamatan Binawidya, " +
        "Kota Pekanbaru, Riau 28293",
    );
  });

  it("maksud, tujuan, kegiatan, kekayaan dan misi", () => {
    expect(ORGANIZATION.objectives).toEqual([
      "Menghimpun seluruh lulusan atau alumni Pesantren Darel Hikmah.",
      "Menjadi sarana silaturahmi dan komunikasi alumni secara positif dan terarah.",
    ]);
    expect(ORGANIZATION.activities).toHaveLength(2);
    expect(ORGANIZATION.activities[0]).toContain("ukhuwah Islamiah");
    expect(ORGANIZATION.assetsStatement).toContain("(Anggaran Dasar Pasal 6)");
    expect(ORGANIZATION.mission).toBe(
      "Menghimpun alumni Pesantren Darel Hikmah dan menjadi sarana silaturahmi serta komunikasi alumni yang " +
        "positif dan terarah.",
    );
    expect(ORGANIZATION.email).toBe("bantuan@kapdh.or.id");
  });

  it("email resmi satu sumber dengan kanal bantuan awal (lib/site OFFICIAL_EMAIL)", () => {
    expect(ORGANIZATION.email).toBe(OFFICIAL_EMAIL);
    expect(DEFAULT_SUPPORT_EMAIL).toBe(OFFICIAL_EMAIL);
  });

  it("dibekukan sampai ke dalam", () => {
    expect(Object.isFrozen(ORGANIZATION)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION.sk)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION.address)).toBe(true);
    expect(Object.isFrozen(ORGANIZATION.objectives)).toBe(true);
  });
});

describe("organizationJsonLd (schema.org)", () => {
  const ld = organizationJsonLd(SITE);

  it("bertipe NGO dengan nama, nama hukum dan URL situs", () => {
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("NGO");
    expect(ld["@type"]).not.toBe("EducationalOrganization");
    expect(ld.name).toBe("Keluarga Alumni Pesantren Darel Hikmah");
    expect(ld.legalName).toBe(ORGANIZATION.legalName);
    expect(ld.alternateName).toBe("KAPDH");
    expect(ld.url).toBe("https://kapdh.or.id/");
    expect(ld.logo).toBe("https://kapdh.or.id/logo-kapdh.png");
    expect(ld.email).toBe("bantuan@kapdh.or.id");
    expect(ld.foundingDate).toBe("2023-03-27");
    expect(ld.description).toBe(ORGANIZATION.mission);
  });

  it("URL mengikuti akar situs walau diberi path", () => {
    const other = organizationJsonLd(new URL("https://baru.kapdh.or.id/tentang"));
    expect(other.url).toBe("https://baru.kapdh.or.id/");
    expect(other.logo).toBe("https://baru.kapdh.or.id/logo-kapdh.png");
  });

  it("identifier memuat nomor SK AHU", () => {
    expect(ld.identifier).toEqual({
      "@type": "PropertyValue",
      propertyID: "SK Menteri Hukum dan HAM (AHU)",
      value: SK_NUMBER,
    });
  });

  it("alamat PostalAddress sama dengan alamat surat di footer dan /kontak (tanpa nama pesantren)", () => {
    expect(ld.address).toEqual({
      "@type": "PostalAddress",
      streetAddress: "Jalan Manyar Sakti, Kelurahan Simpang Baru, Kecamatan Binawidya",
      addressLocality: "Kota Pekanbaru",
      addressRegion: "Riau",
      postalCode: "28293",
      addressCountry: "ID",
    });
    expect(ORGANIZATION_ADDRESS_LINE.startsWith(`${ld.address.streetAddress}, `)).toBe(true);
  });

  it("tidak memuat NPWP/taxID maupun deret angka NPWP atau NIK", () => {
    for (const json of [JSON.stringify(ORGANIZATION), JSON.stringify(ld)]) {
      expect(json).not.toMatch(/taxid|npwp|vatid|\bnik\b/i);
      // NPWP 15 digit berformat 99.999.999.9-999.999 atau 16 digit (NIK/NPWP baru).
      expect(json).not.toMatch(/\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/);
      expect(json.replace(/[.\-\s]/g, "")).not.toMatch(/\d{15,}/);
    }
  });
});

describe("serializeJsonLd", () => {
  it("meng-escape < agar tidak dapat menutup tag skrip, dan tetap JSON yang sama", () => {
    const data = { name: "</script><script>alert(1)</script><!--" };
    const out = serializeJsonLd(data);
    expect(out).not.toContain("<");
    expect(out).toContain("\\u003c/script>");
    expect(JSON.parse(out)).toEqual(data);
  });

  it("hasil untuk organisasi dapat di-parse kembali sebagai NGO", () => {
    const parsed = JSON.parse(serializeJsonLd(organizationJsonLd(SITE))) as Record<string, unknown>;
    expect(parsed["@type"]).toBe("NGO");
    expect(parsed.legalName).toBe(ORGANIZATION.legalName);
  });
});
