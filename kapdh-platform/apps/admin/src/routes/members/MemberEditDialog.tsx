import { zodResolver } from "@hookform/resolvers/zod";
import type { components } from "@kapdh/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { z } from "zod";
import { api } from "../../api/client";
import { useApiMutation } from "../../api/query";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Choice";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Dialog } from "../../components/ui/Dialog";
import { FormError, FormField } from "../../components/ui/FormField";
import { Input, Select, Textarea } from "../../components/ui/Input";
import { CLASS_OPTIONS, classLabel, GENDER_LABEL, GENDER_OPTIONS, latestCohort } from "./labels";
import { usePreconditionHandler } from "./MemberActionDialogs";
import type { MemberNotice } from "./MemberDetailPage";
import {
  type MemberDetail,
  memberFromConflict,
  memberKeys,
  masterOptionLabel,
  storeMember,
  useMasterOptions,
} from "./queries";

type Update = components["schemas"]["AdminMemberUpdate"];
type MasterItem = components["schemas"]["AdminMasterItem"];

/** Pola SocialHandle kontrak (me.yaml): nama pengguna atau URL https; server memeriksa ulang (N-14). */
export const SOCIAL_HANDLE =
  /^(?:@?[A-Za-z0-9._-]{1,100}|https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[/?#][^\s<>"'`]*)?)$/;
const PHONE = /^\+?[0-9][0-9 -]{5,22}$/;
export const MAX_SKILLS = 10;

const optionalText = (label: string, max: number) =>
  z.string().trim().max(max, `${label} maksimal ${max} karakter.`);

const social = z
  .string()
  .trim()
  .max(200, "Maksimal 200 karakter.")
  .refine(
    (v) => v === "" || SOCIAL_HANDLE.test(v),
    "Isi nama pengguna tanpa spasi atau tautan yang diawali https://.",
  );

/** Pra-validasi klien sesuai AdminMemberUpdate; server tetap sumber kebenaran (ARCHITECTURE §2.1). */
export const memberEditSchema = z
  .object({
    full_name: z
      .string()
      .trim()
      .min(2, "Nama lengkap minimal 2 karakter.")
      .max(120, "Nama maksimal 120 karakter."),
    gender: z.enum(["male", "female"], { error: "Pilih jenis kelamin." }),
    // Rentang sama dengan server: angkatan 1 sampai tahun berjalan WIB - 1996 (PRD 3.5, MembershipKernel).
    cohort: z
      .string()
      .trim()
      .superRefine((v, ctx) => {
        const max = latestCohort();
        if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > max)
          ctx.addIssue({ code: "custom", message: `Angkatan berupa angka 1 sampai ${max}.` });
      }),
    class_in: z.string().regex(/^[1-6]$/, "Pilih kelas masuk."),
    class_out: z.string().regex(/^[1-6]$/, "Pilih kelas keluar."),
    city: optionalText("Kota", 80),
    phone: z
      .string()
      .trim()
      .max(24, "Nomor telepon maksimal 24 karakter.")
      .refine((v) => v === "" || PHONE.test(v), "Nomor telepon tidak valid. Contoh: +62 812-3456-7890."),
    bio: z.string().max(500, "Bio maksimal 500 karakter."),
    last_education_institution: optionalText("Institusi pendidikan", 120),
    last_education_city: optionalText("Kota pendidikan", 80),
    social_instagram: social,
    social_x: social,
    social_facebook: social,
    social_linkedin: social,
    profession_id: z.string(),
    skill_ids: z.array(z.string()).max(MAX_SKILLS, `Pilih paling banyak ${MAX_SKILLS} keahlian.`),
    remove_avatar: z.boolean(),
    reason: z
      .string()
      .trim()
      .min(3, "Alasan perubahan minimal 3 karakter dan tidak boleh hanya spasi.")
      .max(500, "Alasan maksimal 500 karakter."),
  })
  .refine((v) => Number(v.class_out) >= Number(v.class_in), {
    path: ["class_out"],
    message: "Kelas keluar tidak boleh lebih rendah dari kelas masuk.",
  });

export type MemberEditValues = z.input<typeof memberEditSchema>;

export function valuesFrom(m: MemberDetail): MemberEditValues {
  return {
    full_name: m.full_name,
    gender: m.gender,
    cohort: String(m.cohort),
    class_in: String(m.class_in),
    class_out: String(m.class_out),
    city: m.city ?? "",
    phone: m.phone ?? "",
    bio: m.bio ?? "",
    last_education_institution: m.last_education_institution ?? "",
    last_education_city: m.last_education_city ?? "",
    social_instagram: m.social_instagram ?? "",
    social_x: m.social_x ?? "",
    social_facebook: m.social_facebook ?? "",
    social_linkedin: m.social_linkedin ?? "",
    profession_id: m.profession?.id ?? "",
    skill_ids: m.skills.map((s) => s.id),
    remove_avatar: false,
    reason: "",
  };
}

const NULLABLE_TEXT = [
  "city",
  "phone",
  "last_education_institution",
  "last_education_city",
  "social_instagram",
  "social_x",
  "social_facebook",
  "social_linkedin",
] as const;

/**
 * Body PATCH hanya berisi field yang berubah dari data yang dibuka (kontrak: field yang tidak dikirim tidak
 * berubah) ditambah alasan. Teks kosong menjadi null untuk field yang boleh dikosongkan.
 */
export function buildUpdate(values: MemberEditValues, base: MemberDetail): Update {
  const body: Update = { reason: values.reason.trim() };
  const fullName = values.full_name.trim();
  if (fullName !== base.full_name) body.full_name = fullName;
  if (values.gender !== base.gender) body.gender = values.gender as Update["gender"];
  if (Number(values.cohort) !== base.cohort) body.cohort = Number(values.cohort);
  if (Number(values.class_in) !== base.class_in) body.class_in = Number(values.class_in);
  if (Number(values.class_out) !== base.class_out) body.class_out = Number(values.class_out);
  for (const key of NULLABLE_TEXT) {
    const next = values[key].trim() || null;
    if (next !== base[key]) body[key] = next;
  }
  const bio = values.bio.trim() || null;
  if (bio !== base.bio) body.bio = bio;
  const profession = values.profession_id || null;
  if (profession !== (base.profession?.id ?? null)) body.profession_id = profession;
  const before = base.skills.map((s) => s.id);
  const sameSkills =
    before.length === values.skill_ids.length && values.skill_ids.every((id) => before.includes(id));
  if (!sameSkills) body.skill_ids = [...values.skill_ids];
  if (values.remove_avatar && base.avatar_file_id) body.remove_avatar = true;
  return body;
}

/** Field pembentuk prefix AA.SS.JK nomor anggota (PRD 3.5). */
const NUMBER_FIELDS = ["gender", "cohort", "class_in", "class_out"] as const;

export interface IdentityChange {
  label: string;
  before: string;
  after: string;
}

/** Koreksi identitas (nama, jenis kelamin, angkatan, kelas) yang wajib dikonfirmasi (AC F05-6). */
export function identityChanges(body: Update, base: MemberDetail): IdentityChange[] {
  const out: IdentityChange[] = [];
  if (body.full_name !== undefined)
    out.push({ label: "Nama lengkap", before: base.full_name, after: body.full_name });
  if (body.gender !== undefined)
    out.push({ label: "Jenis kelamin", before: GENDER_LABEL[base.gender], after: GENDER_LABEL[body.gender] });
  if (body.cohort !== undefined)
    out.push({ label: "Angkatan", before: String(base.cohort), after: String(body.cohort) });
  if (body.class_in !== undefined)
    out.push({ label: "Kelas masuk", before: classLabel(base.class_in), after: classLabel(body.class_in) });
  if (body.class_out !== undefined)
    out.push({
      label: "Kelas keluar",
      before: classLabel(base.class_out),
      after: classLabel(body.class_out),
    });
  return out;
}

/** Pilihan master: aktif, ditambah master nonaktif yang sudah dipakai anggota (label historis, AC F10-4). */
function masterChoices(
  items: MasterItem[] | undefined,
  current: { id: string; label: string; active?: boolean }[],
): { id: string; label: string }[] {
  const currentIds = new Set(current.map((c) => c.id));
  const out = (items ?? [])
    .filter((i) => i.active || currentIds.has(i.id))
    .map((i) => ({ id: i.id, label: masterOptionLabel(i) }));
  for (const c of current)
    if (!out.some((o) => o.id === c.id))
      out.push({ id: c.id, label: c.active === false ? `${c.label} (nonaktif)` : c.label });
  return out;
}

interface SaveVars {
  body: Update;
  version: string;
}

/**
 * Formulir ubah data administratif dan koreksi identitas anggota (F-15, PRD 3.5, AC F05-6, F15-4).
 * - Hanya field yang berubah dikirim, dengan alasan wajib dan If-Match versi data yang dibuka.
 * - Koreksi identitas meminta konfirmasi berisi nilai lama → baru; nomor baru selalu dari respons server.
 * - 409 VERSION_CONFLICT: data terbaru dari server ditampilkan di halaman, formulir tidak menimpa diam-diam;
 *   tombol Simpan dinonaktifkan sampai admin memuat data terbaru ke formulir.
 * - Master nonaktif tidak dapat dipilih baru, tetapi pilihan lama tetap tampil (AC F10-4).
 */
export function MemberEditDialog({
  member,
  onClose,
  onDone,
}: {
  member: MemberDetail;
  onClose: () => void;
  onDone: (notice: MemberNotice) => void;
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  /** Data yang menjadi dasar formulir (versi If-Match dan pembanding perubahan). */
  const [base, setBase] = useState(member);
  const [conflict, setConflict] = useState(false);
  const [confirmBody, setConfirmBody] = useState<Update | null>(null);
  const form = useForm<MemberEditValues>({
    resolver: zodResolver(memberEditSchema),
    defaultValues: valuesFrom(member),
  });
  const professions = useMasterOptions("professions");
  const skills = useMasterOptions("skills");
  const onPrecondition = usePreconditionHandler(member, onClose, onDone);

  const save = useApiMutation<MemberDetail, SaveVars, MemberEditValues>({
    setError: form.setError,
    request: (v) =>
      api.PATCH("/admin/members/{userId}", {
        params: { path: { userId: base.user_id }, header: { "If-Match": v.version } },
        body: v.body,
      }),
    onReloadLatest: (error) => {
      setConfirmBody(null);
      const current = memberFromConflict(error, base.user_id);
      if (current) storeMember(queryClient, current);
      else void queryClient.invalidateQueries({ queryKey: memberKeys.detail(base.user_id) });
      if (error.code === "VERSION_CONFLICT") setConflict(true);
    },
    onSuccess: (data) => {
      setConfirmBody(null);
      storeMember(queryClient, data);
      onDone({
        tone: "success",
        message: `Data ${data.full_name} disimpan.`,
        ...(data.member_number !== base.member_number
          ? { numberChange: { before: base.member_number, after: data.member_number } }
          : {}),
      });
      onClose();
    },
    onError: (error) => {
      setConfirmBody(null);
      // Prasyarat gagal (mis. anggota mulai menghapus akunnya: status akun berubah tanpa versi data naik):
      // formulir ditutup, data terbaru dimuat dan alasannya diumumkan (PRD 4.5).
      onPrecondition(error);
    },
  });

  function reloadLatest() {
    setBase(member);
    form.reset(valuesFrom(member));
    setConflict(false);
    nameRef.current?.focus();
  }

  const onSubmit = form.handleSubmit((values) => {
    const body = buildUpdate(values, base);
    if (Object.keys(body).length <= 1) {
      form.setError("root.server", {
        type: "manual",
        message: "Belum ada perubahan. Ubah minimal satu data selain alasan.",
      });
      return;
    }
    if (identityChanges(body, base).length > 0) {
      setConfirmBody(body);
      return;
    }
    save.mutate({ body, version: base.version });
  });

  const errors = form.formState.errors;
  const selectedSkills = form.watch("skill_ids");
  const professionChoices = masterChoices(professions.data?.items, base.profession ? [base.profession] : []);
  const skillChoices = masterChoices(skills.data?.items, base.skills);
  const changes = confirmBody ? identityChanges(confirmBody, base) : [];
  const numberAffected = confirmBody ? NUMBER_FIELDS.some((f) => confirmBody[f] !== undefined) : false;

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={!save.isPending}
      size="lg"
      initialFocusRef={nameRef}
      title="Ubah data anggota"
      description={`${base.full_name} | ${base.member_number ?? "Belum bernomor"}. Setiap perubahan tercatat di audit bersama alasannya.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Batal
          </Button>
          <Button
            type="submit"
            form={formId}
            focusableWhenDisabled
            disabled={conflict}
            loading={save.isPending && confirmBody === null}
            loadingText="Menyimpan..."
          >
            Simpan perubahan
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} noValidate onSubmit={onSubmit} className="flex flex-col gap-5">
          {conflict ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md bg-warning-bg p-3 text-sm text-warning"
            >
              <span className="flex items-start gap-2 font-medium">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                Data anggota ini sudah diubah admin lain setelah formulir dibuka. Simpan dinonaktifkan agar
                perubahan tersebut tidak tertimpa (AC F15-4).
              </span>
              <span className="text-text">
                Muat data terbaru ke formulir, periksa, lalu ulangi perubahan Anda.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                leftIcon={<RefreshCw aria-hidden="true" className="size-4" />}
                onClick={reloadLatest}
              >
                Muat data terbaru
              </Button>
            </div>
          ) : null}
          <FormError message={errors.root?.server?.message} />

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-heading text-base font-semibold">Identitas</legend>
            <p role="note" className="rounded-md bg-info-bg p-3 text-xs text-info">
              Mengubah jenis kelamin, angkatan atau kelas menghitung ulang nomor anggota (AA.SS.JK) di server.
              Nomor urut tetap, nomor lama dan baru tercatat di audit, dan QR lama perlu diperbarui (AC
              F05-6).
            </p>
            <FormField<MemberEditValues, "full_name"> name="full_name" label="Nama lengkap" required>
              {(field, a11y) => (
                <Input
                  {...field}
                  {...a11y}
                  ref={(el) => {
                    field.ref(el);
                    nameRef.current = el;
                  }}
                  maxLength={120}
                  autoComplete="off"
                />
              )}
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField<MemberEditValues, "gender"> name="gender" label="Jenis kelamin" required>
                {(field, a11y) => (
                  <Select
                    {...a11y}
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    options={GENDER_OPTIONS}
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                )}
              </FormField>
              <FormField<MemberEditValues, "cohort"> name="cohort" label="Angkatan" required>
                {(field, a11y) => (
                  <Input
                    {...field}
                    {...a11y}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={latestCohort()}
                  />
                )}
              </FormField>
              <FormField<MemberEditValues, "class_in"> name="class_in" label="Kelas masuk" required>
                {(field, a11y) => (
                  <Select
                    {...a11y}
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    options={CLASS_OPTIONS}
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                )}
              </FormField>
              <FormField<MemberEditValues, "class_out"> name="class_out" label="Kelas keluar" required>
                {(field, a11y) => (
                  <Select
                    {...a11y}
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    options={CLASS_OPTIONS}
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                )}
              </FormField>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-heading text-base font-semibold">Domisili dan kontak</legend>
            <p className="text-xs text-text-muted">
              Email hanya dapat dikoreksi lewat alur verifikasi email (F-01); flag privasi tetap pilihan
              anggota.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField<MemberEditValues, "city">
                name="city"
                label="Kota domisili"
                hint="Kosongkan untuk menghapus."
              >
                {(field, a11y) => <Input {...field} {...a11y} maxLength={80} />}
              </FormField>
              <FormField<MemberEditValues, "phone">
                name="phone"
                label="Telepon"
                hint="Contoh: +62 812-3456-7890"
              >
                {(field, a11y) => <Input {...field} {...a11y} type="tel" maxLength={24} autoComplete="off" />}
              </FormField>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-heading text-base font-semibold">
              Profesi, keahlian dan pendidikan
            </legend>
            <FormField<MemberEditValues, "profession_id">
              name="profession_id"
              label="Profesi"
              hint={
                professions.isError
                  ? "Pilihan profesi gagal dimuat; pilihan saat ini dipertahankan."
                  : "Profesi nonaktif tidak dapat dipilih baru (AC F10-4)."
              }
            >
              {(field, a11y) => (
                <Select
                  {...a11y}
                  ref={field.ref}
                  name={field.name}
                  onBlur={field.onBlur}
                  options={[
                    { value: "", label: "Tidak ada" },
                    ...professionChoices.map((c) => ({ value: c.id, label: c.label })),
                  ]}
                  value={field.value}
                  onValueChange={field.onChange}
                />
              )}
            </FormField>
            <fieldset
              aria-describedby="keahlian-petunjuk"
              aria-invalid={errors.skill_ids ? true : undefined}
              className="flex flex-col gap-2"
            >
              <legend className="text-sm font-medium">Keahlian</legend>
              <p id="keahlian-petunjuk" className="text-xs text-text-muted">
                Maksimal {MAX_SKILLS} keahlian ({selectedSkills.length} dipilih). Keahlian nonaktif tidak
                dapat dipilih baru.
              </p>
              {skills.isPending && skillChoices.length === 0 ? (
                <p className="text-sm text-text-muted">Memuat keahlian...</p>
              ) : (
                <div className="grid max-h-56 grid-cols-1 gap-x-3 overflow-y-auto rounded-md border border-divider p-2 sm:grid-cols-2">
                  {skillChoices.map((s) => {
                    const checked = selectedSkills.includes(s.id);
                    return (
                      <Checkbox
                        key={s.id}
                        label={s.label}
                        checked={checked}
                        disabled={!checked && selectedSkills.length >= MAX_SKILLS}
                        onCheckedChange={(on) =>
                          form.setValue(
                            "skill_ids",
                            on ? [...selectedSkills, s.id] : selectedSkills.filter((id) => id !== s.id),
                            { shouldDirty: true, shouldValidate: true },
                          )
                        }
                      />
                    );
                  })}
                </div>
              )}
              {errors.skill_ids?.message ? (
                <p className="text-xs font-medium text-danger">{errors.skill_ids.message}</p>
              ) : null}
            </fieldset>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField<MemberEditValues, "last_education_institution">
                name="last_education_institution"
                label="Institusi pendidikan terakhir"
              >
                {(field, a11y) => <Input {...field} {...a11y} maxLength={120} />}
              </FormField>
              <FormField<MemberEditValues, "last_education_city">
                name="last_education_city"
                label="Kota pendidikan"
              >
                {(field, a11y) => <Input {...field} {...a11y} maxLength={80} />}
              </FormField>
            </div>
            <FormField<MemberEditValues, "bio"> name="bio" label="Bio">
              {(field, a11y) => <Textarea {...field} {...a11y} rows={3} maxLength={500} showCount />}
            </FormField>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-heading text-base font-semibold">Tautan sosial</legend>
            <p className="text-xs text-text-muted">
              Isi nama pengguna atau tautan https://. Kosongkan untuk menghapus.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField<MemberEditValues, "social_instagram"> name="social_instagram" label="Instagram">
                {(field, a11y) => <Input {...field} {...a11y} maxLength={200} autoComplete="off" />}
              </FormField>
              <FormField<MemberEditValues, "social_x"> name="social_x" label="X">
                {(field, a11y) => <Input {...field} {...a11y} maxLength={200} autoComplete="off" />}
              </FormField>
              <FormField<MemberEditValues, "social_facebook"> name="social_facebook" label="Facebook">
                {(field, a11y) => <Input {...field} {...a11y} maxLength={200} autoComplete="off" />}
              </FormField>
              <FormField<MemberEditValues, "social_linkedin"> name="social_linkedin" label="LinkedIn">
                {(field, a11y) => <Input {...field} {...a11y} maxLength={200} autoComplete="off" />}
              </FormField>
            </div>
          </fieldset>

          {base.avatar_file_id ? (
            <Checkbox
              boxed
              label="Hapus foto profil anggota (mis. foto tidak pantas)"
              description="Berkas foto dilepas dari profil dan dibersihkan sistem."
              checked={form.watch("remove_avatar")}
              onCheckedChange={(v) => form.setValue("remove_avatar", v, { shouldDirty: true })}
            />
          ) : null}

          <FormField<MemberEditValues, "reason">
            name="reason"
            label="Alasan perubahan"
            required
            hint="Wajib; dicatat di audit (AC F17-1)."
          >
            {(field, a11y) => (
              <Textarea
                {...field}
                {...a11y}
                rows={2}
                maxLength={500}
                placeholder="Contoh: koreksi kelas keluar sesuai ijazah"
              />
            )}
          </FormField>
        </form>
      </FormProvider>

      <ConfirmDialog
        open={confirmBody !== null}
        onCancel={() => setConfirmBody(null)}
        onConfirm={() => {
          if (confirmBody) save.mutate({ body: confirmBody, version: base.version });
        }}
        pending={save.isPending}
        title="Simpan koreksi identitas?"
        description={
          numberAffected
            ? "Server menghitung ulang nomor anggota dari data baru dengan nomor urut tetap, mencatat nomor lama dan baru di audit, dan menerbitkan QR baru (AC F05-6)."
            : "Koreksi identitas anggota dicatat di audit bersama alasannya."
        }
        confirmLabel="Simpan koreksi"
        acknowledgement="Saya sudah memeriksa data identitas baru dan alasan koreksinya."
      >
        <dl className="flex flex-col gap-2 text-sm">
          {changes.map((c) => (
            <div key={c.label} className="flex flex-col">
              <dt className="text-xs text-text-muted">{c.label}</dt>
              <dd>
                {c.before} → <strong className="font-semibold">{c.after}</strong>
              </dd>
            </div>
          ))}
          <div className="flex flex-col">
            <dt className="text-xs text-text-muted">Nomor anggota saat ini</dt>
            <dd className="font-mono">{base.member_number ?? "Belum bernomor"}</dd>
          </div>
        </dl>
        {numberAffected ? (
          <p className="text-xs text-text-muted">
            Nomor baru ditampilkan setelah disimpan sesuai perhitungan server; klien tidak menentukan nomor.
          </p>
        ) : null}
        <blockquote className="rounded-md border-l-4 border-primary bg-green-50 px-3 py-2 text-sm text-text">
          Alasan: {confirmBody?.reason}
        </blockquote>
      </ConfirmDialog>
    </Dialog>
  );
}
