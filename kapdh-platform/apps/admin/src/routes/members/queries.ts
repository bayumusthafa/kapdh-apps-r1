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
