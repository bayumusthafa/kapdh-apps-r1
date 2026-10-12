import { requireAdmin } from "./auth";
import { error, json, type MockRoute, type S } from "./http";
import { MOCK_PROOF_FILE_ID, MOCK_PROOF_FILE_ID_V2 } from "./payments";

/**
 * Tiruan unggah berkas bertujuan dan akses bertanda tangan (N-10, PRD 5.4). Aturan sama dengan server:
 * JPG/PNG <= 5 MB untuk semua purpose, PDF <= 10 MB hanya untuk payment_proof.
 */
const IMAGE_MAX = 5 * 1024 * 1024;
const PDF_MAX = 10 * 1024 * 1024;
const PURPOSES: S["FilePurpose"][] = ["avatar", "payment_proof", "chat_image", "cover"];

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
    ref: { id: MOCK_PROOF_FILE_ID, purpose: "payment_proof", mime: "image/svg+xml", bytes: 2048 },
    dataUrl: placeholderSvg("Bukti transfer versi 1"),
  });
  files.set(MOCK_PROOF_FILE_ID_V2, {
    ref: { id: MOCK_PROOF_FILE_ID_V2, purpose: "payment_proof", mime: "image/svg+xml", bytes: 2048 },
    dataUrl: placeholderSvg("Bukti transfer versi 2"),
  });
}
reset();

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(placeholderSvg("Pratinjau tidak tersedia"));
    reader.readAsDataURL(file);
  });
}

export const routes: MockRoute[] = [
  {
    method: "POST",
    path: "/files",
    handler: async (req) => {
      const unauth = requireAdmin(req);
      if (unauth) return unauth;
      const form = await req.raw.formData().catch(() => null);
      const purpose = form?.get("purpose");
      const file = form?.get("file");
      if (typeof purpose !== "string" || !PURPOSES.includes(purpose as S["FilePurpose"]))
        return error(400, "VALIDATION_ERROR", "Purpose berkas tidak dikenal.", {
          field_errors: { purpose: ["Purpose tidak dikenal."] },
        });
      if (!(file instanceof Blob))
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
      const ref: S["FileRef"] = {
        id,
        purpose: purpose as S["FilePurpose"],
        mime: file.type,
        bytes: file.size,
      };
      files.set(id, { ref, dataUrl: isImage ? await readAsDataUrl(file) : placeholderSvg("Dokumen PDF") });
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
      } satisfies S["FileAccess"]);
    },
  },
];
