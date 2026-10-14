import { useBlocker } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";

/**
 * Cegah perubahan formulir konten hilang tanpa sengaja: navigasi di dalam aplikasi (termasuk ganti tab/halaman
 * lewat parameter URL) meminta konfirmasi, dan menutup/memuat ulang tab memicu peringatan peramban. Navigasi ke
 * halaman masuk (sesi berakhir/idle, AC F02-5) tidak pernah ditahan. `allowNextNavigation` dipakai setelah simpan
 * berhasil yang langsung berpindah halaman.
 */
export function useLeaveGuard(dirty: boolean, subject = "Perubahan") {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const allowRef = useRef(false);
  if (!dirty) allowRef.current = false;

  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => dirtyRef.current && !allowRef.current && !next.pathname.startsWith("/login"),
    enableBeforeUnload: () => dirtyRef.current && !allowRef.current,
    withResolver: true,
  });

  const allowNextNavigation = useCallback(() => {
    allowRef.current = true;
  }, []);

  const dialog = (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      tone="primary"
      title="Tinggalkan tanpa menyimpan?"
      description={`${subject} yang belum disimpan akan hilang.`}
      confirmLabel="Tinggalkan"
      cancelLabel="Tetap di sini"
      onCancel={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
    />
  );

  return { allowNextNavigation, dialog };
}
