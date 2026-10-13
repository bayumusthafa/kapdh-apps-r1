import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minta fokus SETELAH render berikutnya selesai. Dipakai setelah memuat ulang versi terbaru (AC F15-4): tombol
 * "Muat ulang" yang sedang difokus hilang bersama pemberitahuan konflik, dan editor teks kaya mengganti isinya di
 * efeknya sendiri, sehingga fokus langsung (sinkron) akan jatuh ke <body>. Efek induk berjalan setelah efek anak,
 * jadi fokus dipindah ke isian pertama setelah semuanya stabil (N-11).
 */
export function useDeferredFocus(focus: () => void): () => void {
  const [request, setRequest] = useState(0);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (request > 0) focusRef.current();
  }, [request]);
  return useCallback(() => setRequest((n) => n + 1), []);
}
