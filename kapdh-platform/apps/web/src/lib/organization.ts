/**
 * Identitas hukum perkumpulan KAPDH: sumber tunggal untuk bagian Legalitas di /tentang, identitas di footer setiap
 * halaman, kartu alamat di /kontak, beranda, dan JSON-LD schema.org. Nilai disalin apa adanya dari SK pengesahan
 * Menteri Hukum dan HAM, akta pendirian, dan Anggaran Dasar (AD) perkumpulan; jangan menambah data lain.
 *
 * Sengaja TIDAK memuat NPWP, nama atau NIK pendiri/pengurus, maupun kontak notaris (organization.test.ts menjaganya).
 * Murni dan teruji; tidak boleh mengakses DOM.
 */
import { OFFICIAL_EMAIL } from "./site";

/** Membekukan objek beserta seluruh isinya agar data legal tidak dapat diubah saat build. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const SK_NUMBER = "AHU-0002732.AH.01.07.TAHUN 2023";
const LEGAL_NAME = "Perkumpulan Keluarga Alumni Pesantren Darel Hikmah";

export const ORGANIZATION = deepFreeze({
  /** Nama perkumpulan dalam SK dan akta (di sana tertulis kapital: KELUARGA ALUMNI PESANTREN DAREL HIKMAH). */
  name: "Keluarga Alumni Pesantren Darel Hikmah",
  /** Nama badan hukum sebagaimana ditulis di situs; tanpa kata "Pondok". */
  legalName: LEGAL_NAME,
  shortName: "KAPDH",
  legalForm: "Perkumpulan berbadan hukum",
  /** SK pengesahan pendirian badan hukum perkumpulan. */
  sk: {
    number: SK_NUMBER,
    title: `Keputusan Menteri Hukum dan Hak Asasi Manusia Republik Indonesia Nomor ${SK_NUMBER} tentang Pengesahan Pendirian ${LEGAL_NAME}`,
    /** Sebutan singkat untuk footer dan beranda. */
    shortLabel: "SK Menteri Hukum dan HAM",
    issuedAt: "2023-04-11",
    issuedLabel: "11 April 2023",
    issuedPlace: "Jakarta",
  },
  akta: {
    number: "01",
    date: "2023-03-27",
    dateLabel: "27 Maret 2023",
    notary: "Syarifah Murdalifah, S.H., M.Kn.",
    /** Tempat kedudukan notaris. */
    city: "Kota Pekanbaru",
  },
  /** Asas (AD Pasal 2). */
  principle: "Pancasila dan Undang-Undang Dasar 1945",
  /** Kedudukan (AD Pasal 1); provinsi, kode pos dan negara melengkapi alamat surat. */
  address: {
    place: "Pondok Pesantren Darel Hikmah",
    streetAddress: "Jalan Manyar Sakti",
    kelurahan: "Simpang Baru",
    kecamatan: "Binawidya",
    city: "Kota Pekanbaru",
    province: "Riau",
    postalCode: "28293",
    country: "Indonesia",
    countryCode: "ID",
  },
  /** Kontak resmi yang dipakai di seluruh situs (lib/site OFFICIAL_EMAIL, juga default kanal bantuan). */
  email: OFFICIAL_EMAIL,
  /** Maksud dan tujuan (AD Pasal 3). */
  objectives: [
    "Menghimpun seluruh lulusan atau alumni Pesantren Darel Hikmah.",
    "Menjadi sarana silaturahmi dan komunikasi alumni secara positif dan terarah.",
  ],
  /** Kegiatan (AD Pasal 4). */
  activities: [
    "Meningkatkan kreativitas dan solidaritas serta ukhuwah Islamiah sesama alumni Pesantren Darel Hikmah.",
    "Memajukan almamater, membimbing, membina, dan mengembangkan aspirasi, serta memberdayakan seluruh potensi anggota.",
  ],
  /** Pengelolaan kekayaan (AD Pasal 6). */
  assetsStatement:
    "Kekayaan perkumpulan berasal dari kekayaan awal yang dipisahkan dari kekayaan pendiri, iuran anggota, sumbangan atau bantuan yang tidak mengikat, serta perolehan lain yang sah. Seluruh kekayaan dipergunakan untuk mencapai maksud dan tujuan perkumpulan (Anggaran Dasar Pasal 6).",
  /** Misi satu kalimat (deskripsi JSON-LD dan ringkasan singkat). */
  mission:
    "Menghimpun alumni Pesantren Darel Hikmah dan menjadi sarana silaturahmi serta komunikasi alumni yang positif dan terarah.",
} as const);

const { address } = ORGANIZATION;

/** Jalan sampai kecamatan, tanpa nama tempat kedudukan (footer, /kontak dan PostalAddress JSON-LD). */
const STREET_TO_DISTRICT = `${address.streetAddress}, Kelurahan ${address.kelurahan}, Kecamatan ${address.kecamatan}`;

/** Alamat surat (footer dan /kontak): "Jalan Manyar Sakti, ..., Kota Pekanbaru, Riau 28293". */
export const ORGANIZATION_ADDRESS_LINE = `${STREET_TO_DISTRICT}, ${address.city}, ${address.province} ${address.postalCode}`;

/** Kedudukan lengkap sesuai AD Pasal 1 (diawali nama pondok pesantren). */
export const ORGANIZATION_SEAT_LINE = `${address.place}, ${ORGANIZATION_ADDRESS_LINE}`;

/**
 * Data terstruktur schema.org untuk organisasi (Google, mesin pencari, peninjau nonprofit). Bertipe NGO, bukan
 * EducationalOrganization: KAPDH adalah perkumpulan alumni, bukan lembaga pendidikan.
 */
export function organizationJsonLd(site: URL) {
  return {
    "@context": "https://schema.org",
    "@type": "NGO",
    name: ORGANIZATION.name,
    legalName: ORGANIZATION.legalName,
    alternateName: ORGANIZATION.shortName,
    url: new URL("/", site).href,
    logo: new URL("/logo-kapdh.png", site).href,
    email: ORGANIZATION.email,
    foundingDate: ORGANIZATION.akta.date,
    description: ORGANIZATION.mission,
    address: {
      "@type": "PostalAddress",
      // Alamat surat seperti footer dan /kontak; kedudukan lengkap (diawali nama pesantren) tampil di /tentang.
      streetAddress: STREET_TO_DISTRICT,
      addressLocality: address.city,
      addressRegion: address.province,
      postalCode: address.postalCode,
      addressCountry: address.countryCode,
    },
    identifier: {
      "@type": "PropertyValue",
      propertyID: "SK Menteri Hukum dan HAM (AHU)",
      value: ORGANIZATION.sk.number,
    },
  };
}

/**
 * JSON untuk blok data `<script type="application/ld+json">` yang ditanam mentah (set:html). Setiap "<" di-escape
 * menjadi "\u003c" agar isi tidak dapat menutup tag skrip ("</script>") atau membuka komentar HTML; hasil
 * JSON.parse tetap identik.
 */
export function serializeJsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
