import type { components, Permission } from "@kapdh/contracts";
import { ShieldCheck, UserRound } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { Badge } from "../../components/ui/Badge";
import { Checkbox } from "../../components/ui/Choice";
import { ErrorState, Loading } from "../../components/ui/States";

type Account = components["schemas"]["AdminAccount"];
type Catalog = components["schemas"]["AdminPermissionCatalog"];
type PermissionInfo = components["schemas"]["AdminPermissionInfo"];
type Group = components["schemas"]["AdminPermissionGroup"];

export const ADMINS_KEY = ["admin-admins"] as const;
export const adminDetailKey = (adminId: string) => [...ADMINS_KEY, "detail", adminId] as const;

/** Label kelompok izin berbahasa Indonesia (chip "Role & Akses", guideline hlm. 15). */
export const PERMISSION_GROUP_LABEL: Record<Group, string> = {
  payments: "Pembayaran",
  members: "Anggota",
  content: "Konten",
  events: "Event",
  moderation: "Moderasi",
  audit: "Audit",
  settings: "Pengaturan",
  admins: "Admin",
  notifications: "Notifikasi",
};

/** Kelompok tiap izin (sama dengan katalog kontrak adminListPermissions), untuk chip tanpa memuat katalog. */
export const PERMISSION_GROUP: Record<Permission, Group> = {
  "payments.read": "payments",
  "payments.decide": "payments",
  "members.read": "members",
  "members.manage": "members",
  "content.manage": "content",
  "master.manage": "members",
  "events.manage": "events",
  "events.checkin": "events",
  "moderation.read": "moderation",
  "moderation.resolve": "moderation",
  "audit.read": "audit",
  "audit.export": "audit",
  "settings.manage": "settings",
  "admins.manage": "admins",
  "notifications.manage": "notifications",
};

/** Katalog izin dan peran berlabel (GET /admin/permissions); tetap selama sesi. */
export function usePermissionCatalog() {
  return useApiQuery({
    queryKey: ["admin-permissions"],
    staleTime: Infinity,
    request: ({ signal, headers }) => api.GET("/admin/permissions", { signal, headers }),
  });
}

/**
 * Chip "Role & Akses" (guideline hlm. 15): USER bila tertaut ke akun alumni (konflik kepentingan, PRD 2.3), peran,
 * lalu kelompok izin. Teks selalu tertulis (bukan warna saja).
 */
export function AccessChips({ admin }: { admin: Pick<Account, "role" | "permissions" | "linked_alumni"> }) {
  const groups = [...new Set(admin.permissions.map((p) => PERMISSION_GROUP[p]))];
  return (
    <ul aria-label="Peran dan akses" className="flex flex-wrap gap-1">
      {admin.linked_alumni ? (
        <li>
          <Badge tone="info" icon={<UserRound />}>
            USER
          </Badge>
        </li>
      ) : null}
      <li>
        <Badge tone="primary" icon={<ShieldCheck />}>
          {admin.role === "super_admin" ? "Super Admin" : "Admin"}
        </Badge>
      </li>
      {admin.role === "super_admin" ? (
        <li>
          <Badge tone="neutral">Semua akses</Badge>
        </li>
      ) : (
        groups.map((g) => (
          <li key={g}>
            <Badge tone="neutral">{PERMISSION_GROUP_LABEL[g]}</Badge>
          </li>
        ))
      )}
    </ul>
  );
}

/** Urutkan izin mengikuti katalog (urutan tetap kontrak). */
export function sortByCatalog(perms: Iterable<Permission>, catalog: readonly PermissionInfo[]): Permission[] {
  const set = new Set(perms);
  return catalog.map((c) => c.permission).filter((p) => set.has(p));
}

/**
 * Tambah/hapus satu izin dengan aturan prasyarat katalog (`requires`): memilih izin ikut memilih prasyaratnya;
 * melepas prasyarat ikut melepas izin yang bergantung padanya. Mengembalikan izin baru dan catatan perubahan
 * otomatis untuk diumumkan.
 */
export function togglePermission(
  current: readonly Permission[],
  permission: Permission,
  checked: boolean,
  catalog: readonly PermissionInfo[],
): { next: Permission[]; note: string | null } {
  const set = new Set(current);
  const label = (p: Permission) => catalog.find((c) => c.permission === p)?.label ?? p;
  const auto: string[] = [];
  if (checked) {
    set.add(permission);
    for (const r of catalog.find((c) => c.permission === permission)?.requires ?? [])
      if (!set.has(r)) {
        set.add(r);
        auto.push(`${label(r)} ikut dipilih karena diperlukan ${label(permission)}.`);
      }
  } else {
    set.delete(permission);
    for (const info of catalog)
      if (info.requires.includes(permission) && set.has(info.permission)) {
        set.delete(info.permission);
        auto.push(`${info.label} ikut dilepas karena memerlukan ${label(permission)}.`);
      }
  }
  return { next: sortByCatalog(set, catalog), note: auto.length > 0 ? auto.join(" ") : null };
}

/**
 * Editor izin berlabel Bahasa Indonesia per kelompok (F-16, ARCHITECTURE §4.5). admins.manage tidak dapat
 * ditugaskan (hanya Super Admin). Perubahan prasyarat otomatis diumumkan lewat region live (N-11).
 */
export function PermissionEditor({
  catalog,
  value,
  onChange,
  disabled,
  error,
  legend = "Izin",
}: {
  catalog: Catalog["permissions"];
  value: readonly Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
  error?: string | null;
  legend?: string;
}) {
  const [note, setNote] = useState("");
  const errorId = `${useId()}-galat-izin`;
  const groups = [...new Set(catalog.map((c) => c.group))];
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3"
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g} className="flex flex-col gap-0.5 rounded-md border border-divider p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-primary">
              {PERMISSION_GROUP_LABEL[g]}
            </legend>
            {catalog
              .filter((c) => c.group === g)
              .map((info) => (
                <Checkbox
                  key={info.permission}
                  label={info.label}
                  description={
                    !info.assignable
                      ? "Hanya melekat pada Super Admin."
                      : info.requires.length > 0
                        ? `${info.description} Memerlukan: ${info.requires
                            .map((r) => catalog.find((c) => c.permission === r)?.label ?? r)
                            .join(", ")}.`
                        : info.description
                  }
                  checked={value.includes(info.permission)}
                  disabled={disabled || !info.assignable}
                  onCheckedChange={(checked) => {
                    const result = togglePermission(value, info.permission, checked, catalog);
                    setNote(result.note ?? "");
                    onChange(result.next);
                  }}
                />
              ))}
          </fieldset>
        ))}
      </div>
      <p role="status" aria-live="polite" className="text-xs text-info">
        {note}
      </p>
      {error ? (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Pembungkus katalog: memuat, galat, atau editor. */
export function CatalogGate({ children }: { children: (catalog: Catalog["permissions"]) => ReactNode }) {
  const catalog = usePermissionCatalog();
  if (catalog.isPending) return <Loading label="Memuat katalog izin..." rows={3} />;
  if (catalog.isError)
    return <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} compact />;
  return <>{children(catalog.data.permissions)}</>;
}
