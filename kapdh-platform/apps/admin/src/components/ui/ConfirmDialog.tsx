import { TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "./Button";
import { Checkbox } from "./Choice";
import { Dialog } from "./Dialog";
import { Input } from "./Input";

/**
 * Konfirmasi tindakan (PRD 4.5: tolak, suspend, batal, hapus, ubah izin wajib dikonfirmasi).
 * Nada `danger` adalah konfirmasi dua langkah: tombol pemicu membuka dialog, lalu tombol konfirmasi baru aktif
 * setelah admin mencentang pernyataan memahami akibatnya (atau mengetik teks konfirmasi bila `confirmText`
 * diisi). Fokus awal berada pada "Batal" agar Enter tidak langsung menjalankan tindakan destruktif.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  /** Ringkasan apa yang akan terjadi, mis. alasan penolakan yang akan dikirim ke alumni. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** Teks pernyataan pada langkah kedua (nada danger). */
  acknowledgement?: string;
  /** Bila diisi, admin harus mengetik teks ini persis (mis. judul event) sebagai langkah kedua. */
  confirmText?: string;
  /** Permintaan sedang berjalan: tombol konfirmasi memuat dan dialog tidak dapat ditutup. */
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Batal",
  tone = "danger",
  acknowledgement = "Saya memahami akibat tindakan ini.",
  confirmText,
  pending = false,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState("");
  const typedId = useId();

  // Setiap kali dibuka, langkah kedua dimulai dari awal.
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setTyped("");
    }
  }, [open]);

  const twoStep = tone === "danger";
  const secondStepDone =
    !twoStep || (confirmText !== undefined ? typed.trim() === confirmText : acknowledged);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      role="alertdialog"
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {tone === "danger" ? <TriangleAlert aria-hidden="true" className="size-5 text-danger" /> : null}
          {title}
        </span>
      }
      description={description}
      dismissable={!pending}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger-solid" : "primary"}
            loading={pending}
            disabled={!secondStepDone}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {twoStep && confirmText !== undefined ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={typedId} className="text-sm font-medium">
            Ketik <strong className="font-semibold">{confirmText}</strong> untuk melanjutkan
          </label>
          <Input
            id={typedId}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            disabled={pending}
          />
        </div>
      ) : null}
      {twoStep && confirmText === undefined ? (
        <Checkbox
          label={acknowledgement}
          checked={acknowledged}
          onCheckedChange={setAcknowledged}
          disabled={pending}
        />
      ) : null}
    </Dialog>
  );
}
