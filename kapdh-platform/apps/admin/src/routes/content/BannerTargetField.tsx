import { api } from "../../api/client";
import { unwrap } from "../../api/query";
import { useAuth } from "../../auth/session";
import { RadioGroup } from "../../components/ui/Choice";
import { Combobox, type ComboboxOption } from "../../components/ui/Combobox";
import { Field } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { formatDate } from "../../lib/format";
import type { BannerTargetType, S } from "./contentApi";
import { BANNER_TARGET_LABEL, POST_STATE, TargetUnavailableBadge } from "./labels";

/** Alasan tujuan tersimpan tidak dapat dibuka anggota, per jenis tujuan (AC F08-2). */
const UNAVAILABLE_REASON: Partial<Record<BannerTargetType, string>> = {
  post: "Berita tujuan belum terbit, sudah diarsipkan atau sudah dihapus.",
  event: "Event tujuan masih draf, dibatalkan, sudah selesai atau sudah dihapus.",
  page: "Halaman tujuan belum pernah terbit atau sudah dihapus.",
};

const EVENT_STATUS_LABEL: Record<S["EventStatus"], string> = {
  draft: "Draf",
  open: "Pendaftaran dibuka",
  closed: "Pendaftaran ditutup",
  done: "Selesai",
  cancelled: "Dibatalkan",
};

/** Teks tujuan banner untuk tabel dan ringkasan (AC F08-2). */
export function targetText(target: Pick<S["AdminBannerTarget"], "type" | "value" | "label">): string {
  switch (target.type) {
    case "none":
      return "Tanpa tujuan (hanya gambar)";
    case "url":
      return `Tautan luar: ${target.value ?? "-"}`;
    case "post":
      return `Berita: ${target.label ?? "(tidak ditemukan)"}`;
    case "event":
      return `Event: ${target.label ?? "(tidak ditemukan)"}`;
    case "page":
      return `Halaman: ${target.label ?? target.value ?? "(tidak ditemukan)"}`;
  }
}

const SEARCH_LIMIT = 10;

async function searchPosts(q: string, signal: AbortSignal): Promise<ComboboxOption[]> {
  const page = await unwrap(
    api.GET("/admin/content/posts", {
      params: { query: { q, limit: SEARCH_LIMIT, sort: "updated_at_desc" } },
      signal,
    }),
  );
  return page.items.map((p) => ({
    value: p.id,
    label: p.title,
    description: `${POST_STATE[p.state].label} | /news/${p.slug}`,
  }));
}

async function searchEvents(q: string, signal: AbortSignal): Promise<ComboboxOption[]> {
  const page = await unwrap(
    api.GET("/admin/events", { params: { query: { q, limit: SEARCH_LIMIT } }, signal }),
  );
  return page.items.map((e) => ({
    value: e.id,
    label: e.title,
    description: `${EVENT_STATUS_LABEL[e.status] ?? e.status} | ${formatDate(e.starts_at, e.timezone)}`,
  }));
}

async function searchPages(q: string, signal: AbortSignal): Promise<ComboboxOption[]> {
  const page = await unwrap(
    api.GET("/admin/content/pages", { params: { query: { q, limit: SEARCH_LIMIT } }, signal }),
  );
  return page.items.map((p) => ({
    value: p.slug,
    label: p.title,
    description: p.published_version
      ? `Versi ${p.published_version} tayang | /${p.slug}`
      : `Belum terbit | /${p.slug}`,
  }));
}

export interface BannerTargetValue {
  type: BannerTargetType;
  value: string | null;
  /** Label tampilan pilihan (judul berita/event/halaman). */
  label: string | null;
}

/**
 * Pemilih tujuan banner (kontrak AdminBannerCreateRequest, AC F08-2): tanpa tujuan, berita (cari judul), event (cari
 * judul; memerlukan izin events.manage karena memakai daftar event admin, selain itu ID event ditempel dan server
 * memeriksanya), halaman (cari judul, disimpan sebagai slug), atau tautan luar https. Tujuan internal diperiksa ada
 * oleh server saat disimpan; bila kemudian tidak tersedia, tabel dan aplikasi menandainya.
 */
export function BannerTargetField({
  target,
  onChange,
  typeError,
  valueError,
  disabled,
  unavailable,
}: {
  target: BannerTargetValue;
  onChange: (next: BannerTargetValue) => void;
  typeError?: string | null;
  valueError?: string | null;
  disabled?: boolean;
  /** Tujuan tersimpan tidak lagi dapat dibuka anggota (AdminBannerTarget.available = false). */
  unavailable?: boolean;
}) {
  const auth = useAuth();
  const selected: ComboboxOption | null =
    target.value && target.label ? { value: target.value, label: target.label } : null;
  const pick = (option: ComboboxOption | null) =>
    onChange({ type: target.type, value: option?.value ?? null, label: option?.label ?? null });

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup<BannerTargetType>
        legend="Tujuan saat banner diketuk"
        orientation="horizontal"
        required
        value={target.type}
        error={typeError}
        onValueChange={(type) => onChange({ type, value: null, label: null })}
        options={(Object.keys(BANNER_TARGET_LABEL) as BannerTargetType[]).map((value) => ({
          value,
          label: BANNER_TARGET_LABEL[value],
          disabled,
        }))}
      />
      {target.type === "none" ? (
        <p className="text-sm text-text-muted">Banner hanya menampilkan gambar dan tidak dapat diketuk.</p>
      ) : null}
      {target.type === "post" ? (
        <Combobox
          label="Berita tujuan"
          required
          value={selected}
          onValueChange={pick}
          loadOptions={searchPosts}
          placeholder="Ketik judul berita"
          error={valueError}
          disabled={disabled}
          hint="Bila berita belum terbit, diarsipkan atau dihapus, banner ditandai tujuan tidak tersedia."
        />
      ) : null}
      {target.type === "event" && auth.can("events.manage") ? (
        <Combobox
          label="Event tujuan"
          required
          value={selected}
          onValueChange={pick}
          loadOptions={searchEvents}
          placeholder="Ketik judul event"
          error={valueError}
          disabled={disabled}
          hint="Event draf, dibatalkan atau selesai membuat banner ditandai tujuan tidak tersedia."
        />
      ) : null}
      {target.type === "event" && !auth.can("events.manage") ? (
        <Field
          label="ID event tujuan"
          required
          error={valueError}
          hint="Daftar event memerlukan izin events.manage. Tempel ID event dari pengurus event; server memeriksa event tersebut ada."
        >
          {(a11y) => (
            <Input
              {...a11y}
              value={target.value ?? ""}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder="0199e100-0000-7000-8000-000000000000"
              onChange={(e) =>
                onChange({
                  type: "event",
                  value: e.target.value.trim() || null,
                  label: e.target.value.trim() || null,
                })
              }
            />
          )}
        </Field>
      ) : null}
      {target.type === "page" ? (
        <Combobox
          label="Halaman tujuan"
          required
          value={selected}
          onValueChange={pick}
          loadOptions={searchPages}
          placeholder="Ketik judul halaman"
          error={valueError}
          disabled={disabled}
          hint="Halaman yang belum pernah terbit membuat banner ditandai tujuan tidak tersedia."
        />
      ) : null}
      {target.type === "url" ? (
        <Field
          label="Tautan luar"
          required
          error={valueError}
          hint="Hanya https://. Aplikasi menandainya sebagai tautan luar yang dibuka di peramban."
        >
          {(a11y) => (
            <Input
              {...a11y}
              type="url"
              inputMode="url"
              value={target.value ?? ""}
              disabled={disabled}
              maxLength={2048}
              placeholder="https://kapdh.or.id/..."
              onChange={(e) => onChange({ type: "url", value: e.target.value || null, label: null })}
            />
          )}
        </Field>
      ) : null}
      {unavailable ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm">
          <div>
            <TargetUnavailableBadge />
          </div>
          <p className="text-text">
            Tujuan saat ini tidak dapat dibuka anggota. {UNAVAILABLE_REASON[target.type] ?? ""} Pilih tujuan
            lain atau nonaktifkan banner.
          </p>
        </div>
      ) : null}
    </div>
  );
}
