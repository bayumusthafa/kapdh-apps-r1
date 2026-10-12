import { useEffect, useState } from "react";
import { Skeleton } from "./States";

/**
 * Gambar kode QR dari teks (mis. URI otpauth:// saat pendaftaran TOTP admin, F-16). Dibangkitkan di peramban
 * sehingga rahasia TOTP tidak dikirim ke layanan pihak ketiga. Pustaka qrcode dimuat terpisah (lazy).
 * Rahasia juga harus ditampilkan sebagai teks oleh pemanggil sebagai alternatif aksesibel (N-11).
 */
export function QrCode({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    void import("qrcode")
      .then((qr) => qr.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: "M" }))
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (failed)
    return (
      <p role="alert" className="text-sm text-danger">
        Kode QR gagal dibuat. Gunakan kode teks.
      </p>
    );
  if (!src)
    return (
      <span role="status" style={{ width: size, height: size }} className="block">
        <Skeleton className="h-full w-full rounded-md" />
        <span className="sr-only">Membuat kode QR...</span>
      </span>
    );
  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      className="rounded-md border border-divider bg-white"
    />
  );
}
