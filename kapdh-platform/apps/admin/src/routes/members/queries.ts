import type { components } from "@kapdh/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { ApiError } from "../../api/errors";
import { type FetchResult, useApiQuery } from "../../api/query";

type S = components["schemas"];
export type MemberDetail = S["AdminMemberDetail"];
export type MasterKind = S["MasterKind"];

/** Kunci cache area anggota. Semua kunci daftar diawali "admin-members" agar mudah dimuat ulang bersama. */
export const memberKeys = {
  all: ["admin-members"] as const,
  list: (filters: unknown) => ["admin-members", "list", filters] as const,
  detail: (userId: string) => ["admin-member", userId] as const,
  events: (userId: string) => ["admin-member", userId, "events"] as const,
};

export const masterKeys = {
  all: ["admin-masters"] as const,
  options: (kind: MasterKind) => ["admin-masters", kind, "options"] as const,
  list: (kind: MasterKind, filters: unknown) => ["admin-masters", kind, "list", filters] as const,
  details: (kind: MasterKind) => ["admin-master", kind] as const,
  detail: (kind: MasterKind, id: string) => ["admin-master", kind, id] as const,
};

/** Bentuk `current` 409 VERSION_CONFLICT untuk anggota ini (kontrak: AdminMemberDetail tersaring per izin). */
export function memberFromConflict(error: ApiError, userId: string): MemberDetail | null {
  const current = error.current as Partial<MemberDetail> | undefined;
  return current && current.user_id === userId && typeof current.version === "string"
    ? (current as MemberDetail)
    : null;
}

/**
 * Terapkan detail terbaru dari server (hasil tindakan atau `current` konflik) ke cache detail, lalu muat ulang
 * daftar dan histori di latar karena nomor/status/histori dapat ikut berubah.
 */
export function storeMember(queryClient: QueryClient, detail: MemberDetail): void {
  queryClient.setQueryData(memberKeys.detail(detail.user_id), detail);
  void queryClient.invalidateQueries({ queryKey: memberKeys.all });
  void queryClient.invalidateQueries({ queryKey: memberKeys.events(detail.user_id) });
}

/** Muat ulang detail (beserta histori, kunci berawalan sama) dan daftar anggota dari server. */
export function reloadMember(queryClient: QueryClient, userId: string): void {
  void queryClient.invalidateQueries({ queryKey: memberKeys.detail(userId) });
  void queryClient.invalidateQueries({ queryKey: memberKeys.all });
}

/**
 * Prasyarat tindakan anggota tidak terpenuhi dengan keadaan terkini (kontrak admin-members: "400 bila dilanggar
 * dengan versi terkini", PRD 4.5 "tampil status terbaru"): 400 VALIDATION_ERROR tanpa galat per isian. Server
 * mengirim salah satu bentuk: `current` {suspended_at, account_status, version} tanpa field_errors (prasyarat
 * MembershipKernel: sudah/tidak sedang dibatasi, akun sedang dihapus) atau galat akar `field_errors._` (mis. ubah
 * data akun yang sedang dihapus, pemulihan sandi akun yang tidak aktif). Galat per isian (alasan, pesan) bukan
 * prasyarat: tetap ditampilkan pada isiannya.
 */
export function isPreconditionFailure(error: ApiError): boolean {
  return (
    error.code === "VALIDATION_ERROR" &&
    error.status === 400 &&
    Object.keys(error.fieldErrors).every((field) => field === "_")
  );
}

export function useMemberDetail(userId: string) {
  return useApiQuery({
    queryKey: memberKeys.detail(userId),
    request: ({ signal, headers }) =>
      api.GET("/admin/members/{userId}", { params: { path: { userId } }, signal, headers }),
  });
}

/** Batas aman halaman master yang diambil untuk pilihan (100 per halaman, kontrak Limit). */
const MASTER_OPTION_PAGES = 20;

/**
 * Seluruh master satu jenis (aktif dan nonaktif) untuk pilihan filter dan formulir. Daftar master kecil dan
 * terkontrol; halaman kursor diikuti sampai habis (maksimal 2.000 butir). Butuh members.read ATAU master.manage
 * (permissions_any adminListMasters).
 */
export function useMasterOptions(kind: MasterKind, enabled = true) {
  return useApiQuery<S["AdminMasterPage"]>({
    queryKey: masterKeys.options(kind),
    enabled,
    staleTime: 5 * 60_000,
    request: async ({ signal, headers }): Promise<FetchResult<S["AdminMasterPage"]>> => {
      const items: S["AdminMasterItem"][] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MASTER_OPTION_PAGES; page += 1) {
        const res = await api.GET("/admin/masters/{kind}", {
          params: {
            path: { kind },
            query: { sort: "label_asc", limit: 100, ...(cursor ? { cursor } : {}) },
          },
          signal,
          headers,
        });
        if (!res.response.ok || !res.data) return res;
        items.push(...res.data.items);
        if (!res.data.next_cursor) return { data: { ...res.data, items }, response: res.response };
        cursor = res.data.next_cursor;
      }
      return { data: { items, next_cursor: null, total: items.length }, response: new Response(null) };
    },
  });
}

/** Pilihan <select> master: nonaktif ditandai karena hanya berlaku sebagai label historis (AC F10-4). */
export function masterOptionLabel(item: Pick<S["AdminMasterItem"], "label" | "active">): string {
  return item.active ? item.label : `${item.label} (nonaktif)`;
}
