import { Camera, CameraOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Input";
import { Field } from "../../components/ui/FormField";

/**
 * Jendela geser kode yang sama (AC F09-5): selama QR yang sama terus terbaca (zxing membacanya kira-kira tiap
 * 600 ms), kode itu diabaikan berapa lama pun peserta menahan ponselnya. Kode yang sama baru dikirim lagi setelah
 * tidak terbaca selama jeda ini, misalnya ponsel diturunkan lalu ditunjukkan ulang.
 */
export const SAME_CODE_ABSENT_MS = 2_000;

type ScannerState =
  { kind: "idle" } | { kind: "starting" } | { kind: "scanning" } | { kind: "error"; message: string };

interface ScannerControls {
  stop: () => void;
}

/** Pesan galat kamera yang dapat ditindaklanjuti petugas (PRD 4.5); input manual selalu tersedia. */
export function cameraErrorMessage(e: unknown): string {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan peramban, atau ketik kode tiket.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Kamera tidak ditemukan pada perangkat ini. Ketik kode tiket secara manual.";
  if (name === "NotReadableError" || name === "AbortError")
    return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.";
  return "Kamera tidak dapat dibuka. Ketik kode tiket secara manual.";
}

/**
 * Pemindai QR kamera untuk check-in (AC F09-5, F09-6) memakai pustaka @zxing/browser yang dimuat lazy saat kamera
 * dinyalakan, sehingga bundel halaman lain tidak membawanya. Kamera belakang dipilih bawaan; perangkat lain dapat
 * dipilih setelah izin diberikan. Kode yang masih terbaca terus-menerus (lihat {@link SAME_CODE_ABSENT_MS}) dan
 * pemindaian selama `paused` (permintaan check-in sedang berjalan) diabaikan, sehingga QR yang ditahan lama tidak
 * berubah menjadi "Sudah check-in" palsu. Kamera dimatikan saat komponen dilepas.
 */
export function QrScanner({
  onDecode,
  paused,
  label = "Kamera pemindai",
}: {
  onDecode: (text: string) => void;
  paused: boolean;
  label?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const lastRef = useRef<{ text: string; at: number } | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const [state, setState] = useState<ScannerState>({ kind: "idle" });
  const [devices, setDevices] = useState<{ value: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    setState({ kind: "idle" });
  }, []);

  useEffect(
    () => () => {
      runRef.current += 1;
      controlsRef.current?.stop();
      controlsRef.current = null;
    },
    [],
  );

  const start = useCallback(async (preferredDevice?: string) => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const run = ++runRef.current;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState({
        kind: "error",
        message:
          "Peramban ini tidak mendukung kamera atau halaman tidak dibuka lewat HTTPS. Ketik kode tiket.",
      });
      return;
    }
    setState({ kind: "starting" });
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      if (run !== runRef.current) return;
      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 150,
        delayBetweenScanSuccess: 600,
      });
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: preferredDevice ? { deviceId: { exact: preferredDevice } } : { facingMode: "environment" },
      };
      const controls = await reader.decodeFromConstraints(
        constraints,
        videoRef.current ?? undefined,
        (result) => {
          if (!result) return;
          const text = result.getText();
          const now = Date.now();
          const last = lastRef.current;
          if (last && last.text === text && now - last.at < SAME_CODE_ABSENT_MS) {
            // Masih di depan kamera (juga selama permintaan berjalan): perpanjang jendela, jangan kirim ulang.
            last.at = now;
            return;
          }
          if (pausedRef.current) return;
          lastRef.current = { text, at: now };
          onDecodeRef.current(text);
        },
      );
      if (run !== runRef.current) {
        controls.stop();
        return;
      }
      controlsRef.current = controls;
      setState({ kind: "scanning" });
      // Label perangkat baru tersedia setelah izin kamera diberikan.
      const list = await BrowserQRCodeReader.listVideoInputDevices().catch(() => []);
      if (run !== runRef.current) return;
      setDevices(list.map((d, i) => ({ value: d.deviceId, label: d.label || `Kamera ${i + 1}` })));
    } catch (e) {
      if (run !== runRef.current) return;
      setState({ kind: "error", message: cameraErrorMessage(e) });
    }
  }, []);

  const active = state.kind === "scanning" || state.kind === "starting";
  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-lg bg-neutral-900">
        <video
          ref={videoRef}
          aria-label={label}
          muted
          playsInline
          className={active ? "aspect-video w-full object-cover" : "hidden"}
        />
        {active ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[18%] rounded-lg border-4 border-accent/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-neutral-200">
            <CameraOff aria-hidden="true" className="size-8" />
            <span>Kamera mati</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {active ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<CameraOff aria-hidden="true" className="size-4" />}
            onClick={stop}
          >
            Matikan kamera
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Camera aria-hidden="true" className="size-4" />}
            onClick={() => void start(deviceId || undefined)}
          >
            Nyalakan kamera
          </Button>
        )}
        {devices.length > 1 ? (
          <Field label="Pilih kamera" className="flex-[1_1_200px]">
            {(a11y) => (
              <Select
                {...a11y}
                size="sm"
                options={devices}
                value={deviceId}
                placeholder="Kamera bawaan"
                onValueChange={(v) => {
                  setDeviceId(v);
                  if (active) void start(v);
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="text-xs text-text-muted">
        {state.kind === "starting"
          ? "Membuka kamera..."
          : state.kind === "scanning"
            ? paused
              ? "Memproses pemindaian..."
              : "Arahkan QR tiket ke kotak pemindai."
            : null}
      </p>
      {state.kind === "error" ? (
        <p role="alert" className="rounded-md bg-warning-bg p-3 text-sm text-warning">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
