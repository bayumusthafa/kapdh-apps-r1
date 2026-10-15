import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Settings2, ShieldCheck, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { AdminStatusBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader, StatCard } from "../../components/ui/Card";
import { Avatar } from "../../components/ui/DataDisplay";
import { DataTable, useCursorPaging } from "../../components/ui/DataTable";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState } from "../../components/ui/States";
import { formatDateTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { InviteAdminDialog } from "./InviteAdminDialog";
import { AccessChips, ADMINS_KEY } from "./shared";

type Account = components["schemas"]["AdminAccount"];
type Role = components["schemas"]["AdminRole"];
type Status = components["schemas"]["AdminAccountStatus"];
type Sort = components["schemas"]["AdminAccountSort"];

export const ADMIN_PAGE_SIZE = 20;

const ROLE_OPTIONS = [
  { value: "all", label: "Semua peran" },
  { value: "super_admin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
] as const;
const STATUS_OPTIONS = [
  { value: "all", label: "Semua status" },
  { value: "active", label: "Aktif" },
  { value: "invited", label: "Diundang" },
  { value: "disabled", label: "Nonaktif" },
] as const;
const SORT_OPTIONS = [
  { value: "display_name_asc", label: "Nama A-Z" },
  { value: "created_at_desc", label: "Terbaru dibuat" },
  { value: "last_login_at_desc", label: "Login terakhir" },
] as const satisfies readonly { value: Sort; label: string }[];

/** Keterangan status di bawah badge (masa undangan, sejak nonaktif). */
function statusNote(a: Account, now: number): string | null {
  if (a.status === "invited")
    return a.invite_expires_at && Date.parse(a.invite_expires_at) > now
      ? `Undangan s.d. ${formatDateTime(a.invite_expires_at)}`
      : "Undangan kedaluwarsa; kirim ulang";
  if (a.status === "disabled") return a.disabled_at ? `Sejak ${formatDateTime(a.disabled_at)}` : null;
  return a.last_login_at ? `Login ${formatDateTime(a.last_login_at)}` : "Belum pernah login";
}

/**
 * Manajemen Admin (F-16, guideline hlm. 15, izin admins.manage): kartu jumlah admin, Daftar Admin dengan pencarian,
 * filter peran/status dan paging server, chip Role & Akses, serta "Delegasi User jadi Admin". Perubahan peran,
 * izin, status dan pemulihan ada di halaman detail; reautentikasi hanya diminta untuk kirim ulang undangan, koreksi
 * email login dan pemulihan (tindakan kredensial, ADR-025).
 */
export function AdminsPage() {
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Manajemen Admin"
        description="Akun administrator, peran dan hak akses. Akun admin terpisah dari akun alumni (PRD 2.3)."
        actions={
          <PermissionGate anyOf={["admins.manage"]} fallback={null}>
            <Button
              leftIcon={<UserPlus aria-hidden="true" className="size-4" />}
              onClick={() => setInviteOpen(true)}
            >
              Delegasi User jadi Admin
            </Button>
          </PermissionGate>
        }
      />
      <PermissionGate anyOf={["admins.manage"]}>
        <AdminsList />
        <InviteAdminDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      </PermissionGate>
    </>
  );
}

function AdminsList() {
  const auth = useAuth();
  const [q, setQ] = useState("");
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const [sort, setSort] = useState<Sort>("display_name_asc");
  const filters = { q, role, status, sort };
  const paging = useCursorPaging(filters, ADMIN_PAGE_SIZE);
  const list = useApiQuery({
    queryKey: [...ADMINS_KEY, "list", { ...filters, cursor: paging.cursor }],
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/admins", {
        params: {
          query: {
            ...(q ? { q } : {}),
            ...(role !== "all" ? { role } : {}),
            ...(status !== "all" ? { status } : {}),
            sort,
            limit: ADMIN_PAGE_SIZE,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
          },
        },
        signal,
        headers,
      }),
  });
  const selfId = auth.profile?.admin_id;
  const now = useNow().getTime();

  const columns = useMemo<ColumnDef<Account>[]>(
    () => [
      {
        id: "name",
        header: "Nama Admin",
        meta: { rowHeader: true },
        cell: ({ row }) => {
          const a = row.original;
          return (
            <span className="flex items-center gap-2.5">
              <Avatar name={a.display_name} src={a.linked_alumni?.avatar_url} size="sm" />
              <span className="flex flex-col">
                <Link
                  to="/admins/$adminId"
                  params={{ adminId: a.id }}
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {a.display_name}
                </Link>
                {a.id === selfId ? <span className="text-xs text-text-muted">Akun Anda</span> : null}
              </span>
            </span>
          );
        },
      },
      {
        id: "email",
        header: "Email",
        cell: ({ row }) => <span className="break-all">{row.original.email}</span>,
      },
      { id: "access", header: "Role & Akses", cell: ({ row }) => <AccessChips admin={row.original} /> },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const note = statusNote(row.original, now);
          return (
            <span className="flex flex-col items-start gap-1">
              <AdminStatusBadge status={row.original.status} />
              {note ? <span className="text-xs text-text-muted">{note}</span> : null}
            </span>
          );
        },
      },
    ],
    [selfId, now],
  );

  const counts = list.data?.counts;
  return (
    <>
      <div className="flex flex-wrap gap-4">
        <StatCard
          label="Admin"
          value={counts?.total ?? "-"}
          hint={
            counts
              ? `${counts.active} aktif, ${counts.invited} diundang, ${counts.disabled} nonaktif`
              : list.isError
                ? "Jumlah gagal dimuat"
                : undefined
          }
          icon={<ShieldCheck />}
          loading={list.isPending}
        />
      </div>
      <Card aria-labelledby="daftar-admin" className="flex flex-col gap-3 pb-1">
        <CardHeader titleId="daftar-admin" title="Daftar Admin" />
        <div className="px-3.5">
          <DataTable<Account>
            caption="Daftar admin"
            columns={columns}
            data={list.data?.items}
            getRowId={(a) => a.id}
            status={list.status}
            error={list.error}
            onRetry={() => void list.refetch()}
            isFetching={list.isFetching && list.isPlaceholderData}
            total={list.data?.total}
            minWidth={760}
            rowActions={(a) => (
              <Link
                to="/admins/$adminId"
                params={{ adminId: a.id }}
                aria-label={`Kelola ${a.display_name}`}
                className="inline-flex size-11 items-center justify-center rounded-md border border-green-100 bg-green-50 text-primary hover:bg-green-100"
              >
                <Settings2 aria-hidden="true" className="size-[18px]" />
              </Link>
            )}
            pagination={{
              pageIndex: paging.pageIndex,
              pageSize: ADMIN_PAGE_SIZE,
              nextCursor: list.data?.next_cursor,
              onNext: paging.next,
              onPrev: paging.prev,
            }}
            toolbar={
              <>
                <SearchInput
                  label="Cari admin"
                  value={q}
                  onValueChange={setQ}
                  placeholder="Nama atau email admin"
                  className="flex-[1_1_240px]"
                />
                <Field label="Peran" className="flex-[0_1_180px]">
                  {(a11y) => (
                    <Select {...a11y} size="sm" options={ROLE_OPTIONS} value={role} onValueChange={setRole} />
                  )}
                </Field>
                <Field label="Status" className="flex-[0_1_180px]">
                  {(a11y) => (
                    <Select
                      {...a11y}
                      size="sm"
                      options={STATUS_OPTIONS}
                      value={status}
                      onValueChange={setStatus}
                    />
                  )}
                </Field>
                <Field label="Urutkan" className="flex-[0_1_180px]">
                  {(a11y) => (
                    <Select {...a11y} size="sm" options={SORT_OPTIONS} value={sort} onValueChange={setSort} />
                  )}
                </Field>
              </>
            }
            emptyState={
              <EmptyState
                compact
                title="Tidak ada admin yang cocok"
                description="Ubah kata kunci atau filter peran/status."
              />
            }
          />
        </div>
      </Card>
    </>
  );
}
