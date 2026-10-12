import { requireAdmin } from "./auth";
import { error, json, type MockFile, type MockRoute, readMultipart, type S } from "./http";
import { MOCK_PROOF_FILE_ID, MOCK_PROOF_FILE_ID_V2 } from "./payments";

/**
 * Tiruan unggah berkas bertujuan dan akses bertanda tangan (N-10, PRD 5.4). Aturan sama dengan server:
 * JPG/PNG <= 5 MB untuk semua purpose, PDF <= 10 MB hanya untuk payment_proof.
 */
const IMAGE_MAX = 5 * 1024 * 1024;
const PDF_MAX = 10 * 1024 * 1024;
/** Purpose POST /files yang boleh diunggah sesi admin (kontrak files.yaml): bukti penyesuaian dan bukti D13. */
const PURPOSES: S["FileUploadPurpose"][] = ["adjustment_evidence", "payment_proof"];

function fileRef(id: string, purpose: S["FilePurpose"], mime: string, bytes: number): S["FileRef"] {
  return {
    id,
    purpose,
    mime,
    bytes,
    width: null,
    height: null,
    visibility: "private",
    public_url: null,
    created_at: new Date().toISOString(),
  };
}

interface StoredFile {
  ref: S["FileRef"];
  dataUrl: string;
}

const files = new Map<string, StoredFile>();
let seq = 0;

function placeholderSvg(label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#F1F8F0"/><rect x="24" y="24" width="432" height="272" rx="14" fill="#fff" stroke="#E3E3E6"/><text x="240" y="150" font-family="Poppins, sans-serif" font-size="20" text-anchor="middle" fill="#1A4B17">${label}</text><text x="240" y="186" font-family="Poppins, sans-serif" font-size="14" text-anchor="middle" fill="#6B6B6B">Data contoh mode mock</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function reset(): void {
  files.clear();
  seq = 0;
  files.set(MOCK_PROOF_FILE_ID, {
    ref: fileRef(MOCK_PROOF_FILE_ID, "payment_proof", "image/svg+xml", 2048),
    dataUrl: placeholderSvg("Bukti transfer versi 1"),
  });
  files.set(MOCK_PROOF_FILE_ID_V2, {
    ref: fileRef(MOCK_PROOF_FILE_ID_V2, "payment_proof", "image/svg+xml", 2048),
    dataUrl: placeholderSvg("Bukti transfer versi 2"),
  });
}
reset();

function toDataUrl(file: MockFile): string {
  let binary = "";
  for (const b of file.bytes) binary += String.fromCharCode(b);
  return `data:${file.type};base64,${btoa(binary)}`;
}

export const routes: MockRoute[] = [
  {
    method: "POST",
    path: "/files",
    handler: async (req) => {
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      const form = await readMultipart(req.raw);
      const purpose = form?.purpose;
      const file = form?.file;
      if (typeof purpose !== "string" || !PURPOSES.includes(purpose as S["FileUploadPurpose"]))
        return error(400, "VALIDATION_ERROR", "Purpose berkas tidak dikenal.", {
          field_errors: { purpose: ["Purpose tidak dikenal."] },
        });
      if (!file || typeof file === "string")
        return error(400, "VALIDATION_ERROR", "Berkas wajib dipilih.", {
          field_errors: { file: ["Wajib."] },
        });
      const isPdf = file.type === "application/pdf";
      const isImage = file.type === "image/jpeg" || file.type === "image/png";
      if (!isImage && !(isPdf && purpose === "payment_proof"))
        return error(415, "FILE_INVALID", "Tipe berkas tidak diterima.");
      if (file.size > (isPdf ? PDF_MAX : IMAGE_MAX))
        return error(413, "FILE_INVALID", isPdf ? "PDF maksimal 10 MB." : "Gambar maksimal 5 MB.");
      seq += 1;
      const id = `0199e000-0000-7000-8000-${String(seq).padStart(12, "0")}`;
      const ref = fileRef(id, purpose as S["FilePurpose"], file.type, file.size);
      files.set(id, { ref, dataUrl: isImage ? toDataUrl(file) : placeholderSvg("Dokumen PDF") });
      return json(201, ref);
    },
  },
  {
    method: "GET",
    path: "/files/{fileId}/access",
    handler: (req) => {
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      const f = files.get(req.params.fileId ?? "");
      if (!f) return error(404, "NOT_FOUND", "Berkas tidak ditemukan.");
      return json(200, {
        url: f.dataUrl,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        mime: f.ref.mime,
      } satisfies S["FileAccess"]);
    },
  },
];
