import type { components } from "@kapdh/contracts";
import { ERROR_UI } from "@kapdh/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, BACKGROUND_HEADERS, isApiError } from "../api/client";
import { useAuth } from "../auth/session";
import { Button, PaymentStatusBadge } from "../components/ui";
import { formatJakarta, formatRupiah, PAYMENT_TYPE_LABEL } from "../format";

type PaymentStatus = components["schemas"]["PaymentStatus"];
type Detail = components["schemas"]["AdminPaymentDetail"];

export function PaymentsPage() {
  const [status, setStatus] = useState<PaymentStatus>("pending");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["admin-payments", status, q],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/payments", {
        params: { query: { status, ...(q ? { q } : {}) } },
        headers: BACKGROUND_HEADERS,
      });
      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-h1 font-semibold">Verifikasi Pembayaran</h1>
        <p className="text-sm text-text-muted">Setujui hanya bila dana sudah terlihat di rekening tujuan.</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-[1_1_240px] flex-col gap-1.5 text-sm font-medium">
          Cari
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nama atau nomor KTA"
            className="h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as PaymentStatus)}
            className="h-11 rounded-md border border-border bg-surface px-3"
          >
            <option value="pending">Menunggu</option>
            <option value="paid">Disetujui</option>
            <option value="rejected">Ditolak</option>
            <option value="cancelled">Dibatalkan</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[3_1_520px] overflow-hidden rounded-lg border border-divider bg-surface">
          {list.isPending ? (
            <p className="p-4 text-sm">Memuat antrean...</p>
          ) : list.isError ? (
            <div className="flex items-center gap-3 p-4 text-sm">
              <span>Antrean gagal dimuat.</span>
              <Button variant="outline" className="h-11" onClick={() => list.refetch()}>
                Coba lagi
              </Button>
            </div>
          ) : list.data.items.length === 0 ? (
            <p className="p-4 text-sm text-text-muted">Tidak ada pembayaran dengan status ini.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-sm">
                <caption className="sr-only">Antrean pembayaran</caption>
                <thead>
                  <tr className="bg-green-50 text-left">
                    <th scope="col" className="p-3 font-semibold">
                      Dikirim
                    </th>
                    <th scope="col" className="p-3 font-semibold">
                      Alumni
                    </th>
                    <th scope="col" className="p-3 font-semibold">
                      Jenis
                    </th>
                    <th scope="col" className="p-3 text-right font-semibold">
                      Nominal
                    </th>
                    <th scope="col" className="p-3 font-semibold">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((p) => (
                    <tr
                      key={p.id}
                      aria-selected={p.id === selectedId}
                      className={`border-t border-divider ${p.id === selectedId ? "bg-green-100" : p.overdue ? "bg-warning-bg/40" : ""}`}
                    >
                      <td className="p-3">{formatJakarta(p.submitted_at)}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => setSelectedId(p.id)}
                          className="min-h-11 text-left"
                        >
                          <span className="block font-semibold text-primary underline-offset-2 hover:underline">
                            {p.member.full_name}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {p.member.member_number ?? "-"}
                          </span>
                        </button>
                      </td>
                      <td className="p-3">{PAYMENT_TYPE_LABEL[p.type]}</td>
                      <td className="p-3 text-right">{formatRupiah(p.amount)}</td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1.5">
                          <PaymentStatusBadge status={p.status} />
                          {p.overdue ? (
                            <span className="rounded-pill bg-warning-bg px-2.5 py-1 text-xs font-semibold text-warning">
                              Lewat 1 hari kerja
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {selectedId ? <PaymentDecisionPanel key={selectedId} paymentId={selectedId} /> : null}
      </div>
    </section>
  );
}

function PaymentDecisionPanel({ paymentId }: { paymentId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [fundsVerified, setFundsVerified] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["admin-payment", paymentId],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/payments/{paymentId}", {
        params: { path: { paymentId } },
      });
      if (error) throw error;
      return data;
    },
  });

  const decide = useMutation({
    mutationFn: async (input: { decision: "approve" | "reject"; current: Detail }) => {
      const { data, error } = await api.POST("/admin/payments/{paymentId}/decision", {
        params: { path: { paymentId }, header: { "Idempotency-Key": crypto.randomUUID() } },
        body: {
          decision: input.decision,
          expected_proof_version: input.current.proof_version,
          expected_version: input.current.version,
          ...(input.decision === "approve" ? { funds_verified: fundsVerified } : { reason: reason.trim() }),
        },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      setMessage(
        data.status === "paid" ? "Pembayaran disetujui." : "Pembayaran ditolak dan alasan dikirim ke alumni.",
      );
      void queryClient.invalidateQueries({ queryKey: ["admin-payments"] });
      queryClient.setQueryData(["admin-payment", paymentId], data);
    },
    onError: (err) => {
      // Konflik versi: muat ulang data terbaru, jangan menimpa diam-diam (AC F04-3, F04-4).
      setMessage(
        isApiError(err) ? err.message || ERROR_UI[err.code].fallbackMessage : "Terjadi kesalahan. Coba lagi.",
      );
      if (isApiError(err) && ERROR_UI[err.code].action === "reload_latest") void detail.refetch();
    },
  });

  if (detail.isPending)
    return (
      <aside className="flex-[2_1_340px] rounded-lg border border-divider bg-surface p-5 text-sm">
        Memuat detail...
      </aside>
    );
  if (detail.isError)
    return (
      <aside className="flex-[2_1_340px] rounded-lg border border-divider bg-surface p-5 text-sm">
        Detail gagal dimuat.
      </aside>
    );
  const p = detail.data;
  const canDecide = auth.can("payments.decide") && p.status === "pending" && !p.conflict_of_interest;

  return (
    <aside
      aria-labelledby="detail-title"
      className="flex min-w-0 flex-[2_1_340px] flex-col gap-4 rounded-lg border border-divider bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="detail-title" className="font-heading text-h3 font-semibold">
            {p.member.full_name}
          </h2>
          <p className="text-xs text-text-muted">
            {p.member.member_number ?? "-"} | {PAYMENT_TYPE_LABEL[p.type]} | bukti versi {p.proof_version}
          </p>
        </div>
        <PaymentStatusBadge status={p.status} />
      </div>

      <div className="flex h-52 items-center justify-center rounded-md border border-divider bg-neutral-100 text-sm text-text-muted">
        Pratinjau bukti (URL bertanda tangan 10 menit)
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        {p.lines.map((l) => (
          <div key={l.code}>
            <dt className="text-xs text-text-muted">{l.label}</dt>
            <dd className="font-medium">{formatRupiah(l.amount)}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-text-muted">Total</dt>
          <dd className="font-semibold">{formatRupiah(p.amount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">Rekening tujuan</dt>
          <dd>{p.method.provider}</dd>
        </div>
      </dl>

      {p.conflict_of_interest ? (
        <p role="note" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          Pembayaran ini milik akun alumni yang tertaut ke Anda. Mintalah pengurus lain untuk memutus.
        </p>
      ) : null}

      {canDecide ? (
        <>
          <label className="flex items-start gap-3 rounded-md bg-green-50 p-3 text-sm">
            <input
              type="checkbox"
              checked={fundsVerified}
              onChange={(e) => setFundsVerified(e.target.checked)}
              className="mt-0.5 size-5 accent-[var(--color-primary)]"
            />
            Saya sudah memeriksa mutasi rekening {p.method.provider} dan dana {formatRupiah(p.amount)} sudah
            masuk.
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Alasan penolakan (wajib bila menolak)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="rounded-md border border-border p-3 font-normal"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            {confirmReject ? (
              <Button
                variant="danger"
                disabled={decide.isPending || reason.trim().length < 3}
                onClick={() => decide.mutate({ decision: "reject", current: p })}
              >
                Konfirmasi tolak
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={decide.isPending || reason.trim().length < 3}
                onClick={() => setConfirmReject(true)}
              >
                Tolak
              </Button>
            )}
            <Button
              disabled={decide.isPending || !fundsVerified}
              onClick={() => decide.mutate({ decision: "approve", current: p })}
            >
              Setujui
            </Button>
          </div>
        </>
      ) : null}

      {message ? (
        <p role="status" className="text-sm font-medium">
          {message}
        </p>
      ) : null}
    </aside>
  );
}
