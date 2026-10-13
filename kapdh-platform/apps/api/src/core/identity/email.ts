/**
 * Normalisasi email login (PRD 2.3: email unik per jenis identitas): NFKC, tanpa spasi tepi, huruf kecil. Dipakai
 * registrasi, login alumni/admin, bootstrap admin, dan semua pencarian akun berdasarkan email.
 */
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/** Email tersamar untuk challenge OTP (`ab***@domain`), tanpa membuka alamat lengkap (PRD 2.5). */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}
