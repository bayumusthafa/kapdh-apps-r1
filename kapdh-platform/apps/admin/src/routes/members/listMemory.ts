import { type MembersSearch, parseMembersSearch } from "./routes";

/**
 * Pencarian/filter terakhir daftar Manajemen Users di tab ini (F-15, guideline hal. 16), agar breadcrumb dan tautan
 * "kembali ke daftar" dari detail anggota atau halaman master membuka daftar dengan filter yang sama. Disimpan di
 * memori dan sessionStorage (hanya tab ini, hilang saat tab ditutup); nilai dibaca ulang lewat parseMembersSearch
 * sehingga isi penyimpanan yang rusak diabaikan.
 */
const STORAGE_KEY = "kapdh.admin.members.list-search";

let remembered: MembersSearch | null = null;

export function rememberMembersSearch(search: MembersSearch): void {
  remembered = { ...search };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(search));
  } catch {
    // Penyimpanan tidak tersedia (mode privat, kuota): cukup ingatan di memori.
  }
}

export function lastMembersSearch(): MembersSearch {
  if (remembered) return remembered;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    remembered =
      parsed && typeof parsed === "object" ? parseMembersSearch(parsed as Record<string, unknown>) : {};
    return remembered;
  } catch {
    return {};
  }
}

/** Lupakan pencarian terakhir (dipakai uji agar setiap kasus mulai dari daftar tanpa filter). */
export function forgetMembersSearch(): void {
  remembered = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // abaikan
  }
}
