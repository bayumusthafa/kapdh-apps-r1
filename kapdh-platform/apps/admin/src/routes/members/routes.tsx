import {
  ADMIN_MEMBER_SORT_VALUES,
  EFFECTIVE_STATUS_VALUES,
  GENDER_VALUES,
  MASTER_KIND_VALUES,
  type components,
} from "@kapdh/contracts";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

type S = components["schemas"];

/**
 * Filter daftar anggota disimpan di URL agar kembali dari detail mempertahankan pencarian/filter (F-15, guideline
 * hal. 16). Nilai yang tidak dikenal diabaikan; server tetap memvalidasi setiap filter.
 */
export interface MembersSearch {
  q?: string;
  status?: S["EffectiveStatus"];
  cohort?: number;
  city?: string;
  gender?: S["Gender"];
  profession?: string;
  skill?: string;
  sort?: S["AdminMemberSort"];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const t = String(value).trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.includes(value as T) ? (value as T) : undefined;
}

export function parseMembersSearch(search: Record<string, unknown>): MembersSearch {
  const cohort = Number(search.cohort);
  const out: MembersSearch = {
    q: text(search.q, 100),
    status: oneOf(EFFECTIVE_STATUS_VALUES, search.status),
    cohort: Number.isInteger(cohort) && cohort >= 1 && cohort <= 99 ? cohort : undefined,
    city: text(search.city, 80),
    gender: oneOf(GENDER_VALUES, search.gender),
    profession: typeof search.profession === "string" && UUID.test(search.profession) ? search.profession : undefined,
    skill: typeof search.skill === "string" && UUID.test(search.skill) ? search.skill : undefined,
    sort: oneOf(ADMIN_MEMBER_SORT_VALUES, search.sort),
  };
  // Kunci tanpa nilai tidak ditulis ke URL.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as MembersSearch;
}

export interface MemberDetailSearch {
  /** Buka formulir ubah data saat halaman dimuat (ikon ubah pada kartu daftar). */
  edit?: true;
}

export interface MastersSearch {
  kind?: S["MasterKind"];
}

/** Manajemen Users (F-15, F-16 reset alumni, F-10 master profesi/keahlian). Area members. */
export const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members",
  validateSearch: parseMembersSearch,
  beforeLoad: guard("/members"),
  component: lazyRouteComponent(() => import("./MembersListPage"), "MembersPage"),
});

export const memberDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members/$userId",
  validateSearch: (search: Record<string, unknown>): MemberDetailSearch =>
    search.edit === true || search.edit === "true" || search.edit === 1 || search.edit === "1"
      ? { edit: true }
      : {},
  beforeLoad: guard("/members/$userId"),
  component: lazyRouteComponent(() => import("./MemberDetailPage"), "MemberDetailPage"),
});

export const mastersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/members/masters",
  validateSearch: (search: Record<string, unknown>): MastersSearch => {
    const kind = oneOf(MASTER_KIND_VALUES, search.kind);
    return kind ? { kind } : {};
  },
  beforeLoad: guard("/members/masters"),
  component: lazyRouteComponent(() => import("./MastersPage"), "MastersPage"),
});

export const membersRoutes = [membersRoute, memberDetailRoute, mastersRoute] as const;
