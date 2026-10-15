import type { components } from "@kapdh/contracts";
import { Ban, CircleCheck, Hourglass } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "../../components/ui/Badge";
import { DELETED_ACCOUNT_LABEL, PAYMENT_TYPE_LABEL } from "../../lib/labels";

type MethodKind = components["schemas"]["PaymentMethodKind"];
type AdjustmentKind = components["schemas"]["PaymentAdjustmentKind"];
type AdjustmentStatus = components["schemas"]["PaymentAdjustmentStatus"];
type Member = components["schemas"]["AdminPaymentMember"];
type PaymentType = components["schemas"]["PaymentType"];

/** Jenis rekening tujuan transfer manual (D13); QRIS statis organisasi tanpa nominal (ADR-026). */
export const METHOD_KIND_LABEL: Record<MethodKind, string> = {
  bank: "Bank",
  ewallet: "E-wallet",
  qris: "QRIS",
};

/** Bagian metode bayar yang dipakai label tampilan (snapshot payment maupun metode admin). */
type MethodLike = Pick<
  components["schemas"]["PaymentMethod"],
  "kind" | "provider" | "account_number" | "account_holder"
>;

/**
 * Nama metode untuk tampilan, mis. "Bank BSI" atau "QRIS". Untuk qris `provider` adalah nama metode yang biasanya
 * sudah memuat kata QRIS (bawaan formulir "QRIS"), sehingga jenisnya tidak diulang ("QRIS QRIS").
 */
export function methodTitle(m: MethodLike): string {
  if (m.kind === "qris" && /\bqris\b/i.test(m.provider)) return m.provider;
  return `${METHOD_KIND_LABEL[m.kind]} ${m.provider}`;
}

/** Baris kedua metode: nomor dan pemilik rekening, atau NMID dan nama merchant untuk QRIS (ADR-026). */
export function methodSubtitle(m: MethodLike): string {
  return m.kind === "qris"
    ? `NMID ${m.account_number} a.n. ${m.account_holder}`
    : `${m.account_number} a.n. ${m.account_holder}`;
}

/** Jenis penyesuaian (PRD 3.4, 4.3, D6): refund = pengembalian dana; koreksi = catatan administratif. */
export const ADJUSTMENT_KIND_LABEL: Record<AdjustmentKind, string> = {
  refund: "Refund",
  correction: "Koreksi",
};

const ADJUSTMENT_STATUS: Record<AdjustmentStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  pending: { label: "Menunggu proses", tone: "warning", icon: <Hourglass /> },
  completed: { label: "Selesai", tone: "success", icon: <CircleCheck /> },
  cancelled: { label: "Dibatalkan", tone: "neutral", icon: <Ban /> },
};

export function adjustmentStatusLabel(status: AdjustmentStatus): string {
  return ADJUSTMENT_STATUS[status].label;
}

/** Status penyesuaian berlabel teks + ikon, tidak hanya warna (PRD 4.5, ARCHITECTURE §2.10). */
export function AdjustmentStatusBadge({ status }: { status: AdjustmentStatus }) {
  const s = ADJUSTMENT_STATUS[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

/** Nama pemilik payment; "Akun dihapus" bila datanya sudah dianonimkan (D2, AC F14-4). */
export function memberName(member: Member | null): string {
  return member?.full_name ?? DELETED_ACCOUNT_LABEL;
}

/** Baris kedua identitas pemilik: nomor anggota, atau penanda data dihapus. */
export function memberSubtitle(member: Member | null): string {
  if (!member) return "Data pemilik sudah dihapus";
  return member.member_number ?? "Belum bernomor";
}

/** "Tiket: <judul event>" untuk payment tiket, selain itu label jenis iuran. */
export function paymentTypeText(p: { type: PaymentType; event_title: string | null }): string {
  return p.type === "ticket" && p.event_title ? `Tiket: ${p.event_title}` : PAYMENT_TYPE_LABEL[p.type];
}
