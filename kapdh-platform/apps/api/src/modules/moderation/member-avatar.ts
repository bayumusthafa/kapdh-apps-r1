import type { FileViewer } from "../../core/files/access-policy.js";
import type { FilesService } from "../../core/files/files.service.js";

/**
 * URL foto anggota lain untuk penampil anggota (PRD 5.4, N-09): publik → URL tetap; privat → URL bertanda tangan
 * <= 10 menit yang terikat sesi penampil, HANYA bila kebijakan akses berkas mengizinkan penampil itu (aturan modul
 * profil/direktori/chat). Selain itu null sehingga klien memakai inisial; foto privat tidak pernah bocor lewat daftar.
 */
export async function avatarUrlFor(
  files: FilesService,
  fileId: string | null,
  viewer: FileViewer,
): Promise<string | null> {
  if (!fileId) return null;
  const file = await files.findReady(fileId);
  if (!file) return null;
  if (!(await files.canAccess(file, viewer))) return null;
  const { url } = await files.signedUrl(file, {
    userId: viewer.userId,
    sessionId: viewer.sessionId,
    sessionVersion: viewer.sessionVersion,
  });
  return url;
}
