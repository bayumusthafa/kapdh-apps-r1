import type { components } from "@kapdh/contracts";
import { keepPreviousData } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Pencil, Settings2, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/client";
import { useApiQuery } from "../../api/query";
import { useAuth } from "../../auth/session";
import { Badge, MembershipStatusBadge } from "../../components/ui/Badge";
import { Button, buttonClass, IconButton } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { useCursorPaging } from "../../components/ui/DataTable";
import { Avatar } from "../../components/ui/DataDisplay";
import { Field } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Input";
import { PageHeader } from "../../components/ui/PageHeader";
import { SearchInput } from "../../components/ui/SearchInput";
import { EmptyState, ErrorState, ForbiddenState, Loading } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { GENDER_OPTIONS, latestCohort, MEMBER_SORT_OPTIONS, STATUS_FILTER_OPTIONS } from "./labels";
import { CursorPager, pageSummary } from "./CursorPager";
import { rememberMembersSearch } from "./listMemory";
import { masterOptionLabel, memberKeys, useMasterOptions } from "./queries";
import { RefreshFailedBanner } from "./RefreshFailedBanner";
import type { MembersSearch } from "./routes";

type Summary = components["schemas"]["AdminMemberSummary"];

/** Ukuran halaman kartu (kelipatan 2, 3 dan 4 kolom; server: bawaan 30, maks 100). */
export const MEMBER_PAGE_SIZE = 24;

/** Ubah filter URL menjadi parameter kueri kontrak adminListMembers. */
function listQuery(search: MembersSearch) {
  return {
    ...(search.q ? { q: search.q } : {}),
    ...(search.status ? { effective_status: search.status } : {}),
    ...(search.cohort ? { cohort: search.cohort } : {}),
    ...(search.city ? { city: search.city } : {}),
    ...(search.gender ? { gender: search.gender } : {}),
    ...(search.profession ? { profession_id: search.profession } : {}),
    ...(search.skill ? { skill_id: search.skill } : {}),
    ...(search.sort ? { sort: search.sort } : {}),
  };
}

/** Jumlah filter panel yang aktif (pencarian dan urutan tidak dihitung). */
function activeFilterCount(search: MembersSearch): number {
  return [search.status, search.cohort, search.city, search.gender, search.profession, search.skill].filter(
    (v) => v !== undefined,
  ).length;
}

/**
 * Halaman Manajemen Users (F-15, guideline hal. 16): total alumni terdaftar, pencarian, filter server (status,
 * angkatan, kota, jenis kelamin, profesi, keahlian), urutan, paging kursor, dan kartu alumni dengan tombol
 * "Informasi Pengguna". Tidak ada tombol hapus: penghapusan akun hanya lewat alur akun anggota (F-14);
 * pembatasan dilakukan dari detail anggota.
 */
export function MembersPage() {
  const auth = useAuth();
  // Rute juga terbuka untuk members.manage, tetapi daftar dan detail memerlukan members.read (kontrak C2).
  if (!auth.can("members.read"))
    return (
      <>
        <PageHeader title="Manajemen Users" />
        <Card>
          <ForbiddenState description="Daftar dan detail anggota memerlukan izin melihat data anggota (members.read). Hubungi Super Admin bila Anda memerlukannya." />
        </Card>
      </>
    );
  return <MembersBrowser />;
}

function MembersBrowser() {
  const auth = useAuth();
  const search = useSearch({ from: "/app/members" });
  const navigate = useNavigate({ from: "/members" });
  const filterCount = activeFilterCount(search);
  const [filtersOpen, setFiltersOpen] = useState(filterCount > 0);
  const panelId = useId();
  const query = listQuery(search);
  const paging = useCursorPaging(query, MEMBER_PAGE_SIZE);
  // Breadcrumb detail anggota dan halaman master kembali ke daftar dengan filter yang sama (F-15).
  useEffect(() => rememberMembersSearch(search), [search]);

  const list = useApiQuery({
    queryKey: memberKeys.list({ ...query, cursor: paging.cursor }),
    placeholderData: keepPreviousData,
    request: ({ signal, headers }) =>
      api.GET("/admin/members", {
        params: {
          query: {
            ...query,
            ...(paging.cursor ? { cursor: paging.cursor } : {}),
            limit: MEMBER_PAGE_SIZE,
          },
        },
        signal,
        headers,
      }),
  });

  function update(patch: Partial<MembersSearch>) {
    void navigate({
      search: (prev: MembersSearch) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return next as MembersSearch;
      },
      replace: true,
    });
  }

  const filtered = filterCount > 0 || Boolean(search.q);
  const total = list.data?.total;
  const description =
    total === undefined
      ? "Memuat jumlah alumni..."
      : filtered
        ? `${total} alumni sesuai pencarian dan filter`
        : `${total} total alumni terdaftar`;
  const canEdit = auth.can("members.manage");

  return (
    <>
      <PageHeader
        title="Manajemen Users"
        description={<span aria-live="polite">{description}</span>}
        actions={
          auth.can("master.manage") ? (
            <Link to="/members/masters" className={buttonClass({ variant: "primary", size: "sm" })}>
              <Settings2 aria-hidden="true" className="size-4" />
              Manajemen Skill &amp; Profesi
            </Link>
          ) : null
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            label="Cari alumni"
            value={search.q ?? ""}
            onValueChange={(q) => update({ q: q || undefined })}
            placeholder="Cari nama, email, No. KTA, kota..."
            className="flex-[1_1_280px]"
          />
          <Button
            variant="outline"
            size="sm"
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? panelId : undefined}
            leftIcon={<SlidersHorizontal aria-hidden="true" className="size-4" />}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            {filterCount > 0 ? `Filter (${filterCount} aktif)` : "Filter"}
          </Button>
          <Field label="Urutkan" className="flex-[0_1_230px]">
            {(a11y) => (
              <Select
                {...a11y}
                size="sm"
                options={MEMBER_SORT_OPTIONS}
                value={search.sort ?? "registered_desc"}
                onValueChange={(sort) => update({ sort: sort === "registered_desc" ? undefined : sort })}
              />
            )}
          </Field>
        </div>
        {filtersOpen ? (
          <FilterPanel id={panelId} search={search} update={update} activeCount={filterCount} />
        ) : null}
      </div>

      <section aria-label="Daftar alumni" className="flex flex-col gap-4">
        <MemberGrid
          list={list}
          canEdit={canEdit}
          filtered={filtered}
          pageIndex={paging.pageIndex}
          onPrev={paging.prev}
          onNext={paging.next}
          onReset={() =>
            update({
              q: undefined,
              status: undefined,
              cohort: undefined,
              city: undefined,
              gender: undefined,
              profession: undefined,
              skill: undefined,
            })
          }
        />
      </section>
    </>
  );
}

function FilterPanel({
  id,
  search,
  update,
  activeCount,
}: {
  id: string;
  search: MembersSearch;
  update: (patch: Partial<MembersSearch>) => void;
  activeCount: number;
}) {
  const professions = useMasterOptions("professions");
  const skills = useMasterOptions("skills");
  const cohortOptions = [
    { value: "all", label: "Semua angkatan" },
    ...Array.from({ length: latestCohort() }, (_, i) => ({
      value: String(i + 1),
      label: `Angkatan ${i + 1}`,
    })),
  ];
  const masterHint = (failed: boolean) => (failed ? "Pilihan gagal dimuat. Muat ulang halaman." : undefined);

  return (
    <div
      id={id}
      role="group"
      aria-label="Filter anggota"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-divider bg-surface p-3.5"
    >
      <Field label="Status keanggotaan" className="flex-[1_1_200px]">
        {(a11y) => (
          <Select
            {...a11y}
            size="sm"
            options={STATUS_FILTER_OPTIONS}
            value={search.status ?? "all"}
            onValueChange={(v) => update({ status: v === "all" ? undefined : v })}
          />
        )}
      </Field>
      <Field label="Angkatan" className="flex-[1_1_160px]">
        {(a11y) => (
          <Select
            {...a11y}
            size="sm"
            options={cohortOptions}
            value={search.cohort ? String(search.cohort) : "all"}
            onValueChange={(v) => update({ cohort: v === "all" ? undefined : Number(v) })}
          />
        )}
      </Field>
      <SearchInput
        label="Kota domisili"
        value={search.city ?? ""}
        onValueChange={(city) => update({ city: city || undefined })}
        placeholder="Nama kota persis"
        maxLength={80}
        className="flex-[1_1_180px]"
      />
      <Field label="Jenis kelamin" className="flex-[1_1_160px]">
        {(a11y) => (
          <Select
            {...a11y}
            size="sm"
            options={[{ value: "all", label: "Semua" }, ...GENDER_OPTIONS]}
            value={search.gender ?? "all"}
            onValueChange={(v) => update({ gender: v === "all" ? undefined : v })}
          />
        )}
      </Field>
      <Field label="Profesi" className="flex-[1_1_220px]" hint={masterHint(professions.isError)}>
        {(a11y) => (
          <Select
            {...a11y}
            size="sm"
            disabled={!professions.data}
            options={[
              { value: "all", label: professions.data ? "Semua profesi" : "Memuat profesi..." },
              ...(professions.data?.items ?? []).map((m) => ({ value: m.id, label: masterOptionLabel(m) })),
            ]}
            value={search.profession ?? "all"}
            onValueChange={(v) => update({ profession: v === "all" ? undefined : v })}
          />
        )}
      </Field>
      <Field label="Keahlian" className="flex-[1_1_220px]" hint={masterHint(skills.isError)}>
        {(a11y) => (
          <Select
            {...a11y}
            size="sm"
            disabled={!skills.data}
            options={[
              { value: "all", label: skills.data ? "Semua keahlian" : "Memuat keahlian..." },
              ...(skills.data?.items ?? []).map((m) => ({ value: m.id, label: masterOptionLabel(m) })),
            ]}
            value={search.skill ?? "all"}
            onValueChange={(v) => update({ skill: v === "all" ? undefined : v })}
          />
        )}
      </Field>
      <Button
        variant="ghost"
        size="sm"
        focusableWhenDisabled
        disabled={activeCount === 0}
        onClick={() =>
          update({
            status: undefined,
            cohort: undefined,
            city: undefined,
            gender: undefined,
            profession: undefined,
            skill: undefined,
          })
        }
      >
        Reset filter
      </Button>
    </div>
  );
}

interface ListQuery {
  data?: components["schemas"]["AdminMemberPage"] | undefined;
  status: "pending" | "error" | "success";
  error: unknown;
  isFetching: boolean;
  isPlaceholderData: boolean;
  refetch: () => unknown;
}

/**
 * Kisi kartu alumni dengan keadaan memuat, galat, kosong, halaman lanjutan yang kosong, ringkasan "Menampilkan
 * X-Y dari Z" dan tombol halaman yang tetap memegang fokus saat nonaktif (N-11).
 */
function MemberGrid({
  list,
  canEdit,
  filtered,
  pageIndex,
  onPrev,
  onNext,
  onReset,
}: {
  list: ListQuery;
  canEdit: boolean;
  filtered: boolean;
  pageIndex: number;
  onPrev: () => void;
  onNext: (cursor: string) => void;
  onReset: () => void;
}) {
  const prevRef = useRef<HTMLButtonElement>(null);
  const items = list.data?.items ?? [];
  const loadingPage = list.isFetching && list.isPlaceholderData;
  const shown = items.length;
  const emptyLaterPage = list.data !== undefined && shown === 0 && pageIndex > 0;

  let body;
  if (list.status === "pending")
    body = (
      <Card>
        <Loading label="Memuat daftar alumni..." rows={6} />
      </Card>
    );
  else if (list.status === "error" && list.data === undefined)
    body = (
      <Card>
        <ErrorState error={list.error} onRetry={() => void list.refetch()} compact />
      </Card>
    );
  else if (emptyLaterPage)
    body = (
      <Card>
        <EmptyState
          compact
          title="Halaman ini sudah kosong"
          description="Data di halaman ini sudah berpindah. Data lain masih ada di halaman sebelumnya."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onPrev();
                prevRef.current?.focus();
              }}
            >
              Kembali ke halaman sebelumnya
            </Button>
          }
        />
      </Card>
    );
  else if (shown === 0)
    body = (
      <Card>
        <EmptyState
          compact
          icon={<Users />}
          title={filtered ? "Tidak ada alumni yang cocok" : "Belum ada alumni terdaftar"}
          description={
            filtered
              ? "Ubah kata kunci atau filter pencarian."
              : "Alumni yang mendaftar lewat aplikasi akan tampil di sini."
          }
          action={
            filtered ? (
              <Button variant="outline" size="sm" onClick={onReset}>
                Hapus pencarian dan filter
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  else
    body = (
      <ul
        aria-label="Kartu alumni"
        aria-busy={loadingPage || undefined}
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4",
          loadingPage && "opacity-60",
        )}
      >
        {items.map((m) => (
          <MemberCard key={m.user_id} member={m} canEdit={canEdit} />
        ))}
      </ul>
    );

  const summary = pageSummary({
    loading: loadingPage,
    pageIndex,
    pageSize: MEMBER_PAGE_SIZE,
    shown,
    total: list.data?.total,
    noun: "alumni",
  });

  return (
    <>
      {/* Refetch latar gagal padahal kartu sudah tampil: kartu dipertahankan, galat sebaris (PRD 4.5). */}
      {list.status === "error" && list.data !== undefined ? (
        <RefreshFailedBanner
          error={list.error}
          subject="Daftar alumni"
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {body}
      {list.data !== undefined ? (
        <CursorPager
          className="rounded-lg border border-divider bg-surface"
          summary={summary}
          pageIndex={pageIndex}
          nextCursor={list.data?.next_cursor}
          loading={loadingPage}
          onPrev={onPrev}
          onNext={onNext}
          prevRef={prevRef}
        />
      ) : null}
    </>
  );
}

/** Kartu alumni sesuai guideline hal. 16: inisial/foto, nama, email, angkatan, alamat (kota), nomor, status. */
function MemberCard({ member: m, canEdit }: { member: Summary; canEdit: boolean }) {
  const navigate = useNavigate();
  const titleId = `alumni-${m.user_id}`;
  return (
    <li className="min-w-0">
      <article
        aria-labelledby={titleId}
        className="flex h-full flex-col gap-3 rounded-lg border border-divider bg-surface p-4 shadow-card"
      >
        <div className="flex items-start gap-3">
          <Avatar name={m.full_name} src={m.avatar_url} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 id={titleId} className="truncate text-sm font-semibold text-text">
              {m.full_name}
            </h2>
            <span className="truncate text-xs text-text-muted">{m.email}</span>
          </div>
          {m.has_linked_admin ? (
            <Badge tone="primary" icon={<ShieldCheck />}>
              Admin
            </Badge>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted">Angkatan</dt>
            <dd>
              {m.cohort} <span className="text-xs text-text-muted">({m.cohort_code})</span>
            </dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted">Alamat</dt>
            <dd className="truncate">{m.city ?? "-"}</dd>
          </div>
          <div className="col-span-2 flex min-w-0 flex-col">
            <dt className="sr-only">Nomor anggota</dt>
            <dd className="font-mono text-sm">{m.member_number ?? "Belum bernomor"}</dd>
          </div>
          {m.profession_label ? (
            <div className="col-span-2 flex min-w-0 flex-col">
              <dt className="sr-only">Profesi</dt>
              <dd className="truncate text-xs text-text-muted">{m.profession_label}</dd>
            </div>
          ) : null}
        </dl>
        <MembershipStatusBadge status={m.effective_status} />
        <div className="mt-auto flex items-center gap-2 pt-1">
          {/* Akun yang sedang dihapus tidak dapat diubah (F-14); konflik kepentingan diperiksa di detail. */}
          {canEdit && m.account_status !== "deletion_pending" && m.account_status !== "deleted" ? (
            <IconButton
              tone="primary"
              icon={<Pencil />}
              label={`Ubah data ${m.full_name}`}
              onClick={() =>
                void navigate({
                  to: "/members/$userId",
                  params: { userId: m.user_id },
                  search: { edit: true },
                })
              }
            />
          ) : null}
          <Link
            to="/members/$userId"
            params={{ userId: m.user_id }}
            aria-label={`Informasi Pengguna ${m.full_name}`}
            className={buttonClass({ variant: "outline", size: "sm", className: "min-w-0 flex-1" })}
          >
            Informasi Pengguna
          </Link>
        </div>
      </article>
    </li>
  );
}
