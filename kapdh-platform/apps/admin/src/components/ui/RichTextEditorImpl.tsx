import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
  Unlink,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field } from "./FormField";
import { Input } from "./Input";
import type { RichTextEditorProps } from "./RichTextEditor";

/**
 * Implementasi editor teks kaya (TipTap) untuk berita dan halaman (F-08). HTML keluaran BUKAN tepercaya:
 * server tetap menyanitasi sebelum menyimpan/menerbitkan (PRD 3.8); aturan di sini membuat isi editor sejak awal
 * sesuai kebijakan yang sama (N-11):
 * - tautan hanya https:// atau mailto:, baik dari dialog, ketikan otomatis, tempel, maupun HTML yang dimuat
 *   (`isAllowedUri`); tautan lain kehilangan tautannya tetapi teksnya tetap;
 * - gambar hanya https:// (tempel/muat); gambar yang ditempel tanpa teks alternatif dibuang, dan dialog
 *   "Sisipkan gambar" mewajibkan teks alternatif.
 * Dimuat terpisah (lazy) agar bundel utama tetap kecil.
 */
const SAFE_LINK = /^(https:\/\/|mailto:)/i;
const SAFE_IMAGE = /^https:\/\//i;

/** Gambar yang hanya menerima sumber https (HTML dimuat maupun ditempel). */
const SafeImage = Image.extend({
  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => (SAFE_IMAGE.test(element.getAttribute("src") ?? "") ? null : false),
      },
    ];
  },
});

/**
 * Bersihkan HTML yang ditempel/diseret ke editor sebelum di-parse: gambar non-https atau tanpa teks alternatif
 * dibuang (teks alternatif wajib, N-11). Tautan disaring oleh `isAllowedUri` ekstensi Link.
 */
export function sanitizePastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const alt = img.getAttribute("alt")?.trim() ?? "";
    if (!SAFE_IMAGE.test(src) || !alt) img.remove();
  });
  return doc.body.innerHTML;
}

export default function RichTextEditorImpl({
  value,
  onChange,
  label,
  hint,
  error,
  required,
  disabled,
  placeholder,
}: RichTextEditorProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    editable: !disabled,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({ link: false, codeBlock: false, heading: { levels: [2, 3] } }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ["https", "mailto"],
        defaultProtocol: "https",
        // Berlaku untuk HTML dimuat/ditempel, perintah setLink dan tautan otomatis (bukan hanya autolink).
        isAllowedUri: (url) => SAFE_LINK.test(url),
        shouldAutoLink: (url) => SAFE_LINK.test(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
      SafeImage.configure({ inline: false, allowBase64: false }),
    ],
    content: value,
    editorProps: {
      transformPastedHTML: sanitizePastedHtml,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-labelledby": labelId,
        ...(hintId || errId ? { "aria-describedby": [errId, hintId].filter(Boolean).join(" ") } : {}),
        ...(error ? { "aria-invalid": "true" } : {}),
        ...(required ? { "aria-required": "true" } : {}),
        ...(placeholder ? { "aria-placeholder": placeholder } : {}),
        class: "prose-kapdh min-h-48 px-3 py-2.5 text-sm outline-none",
      },
    },
    onUpdate: ({ editor: e }) => onChangeRef.current(e.isEmpty ? "" : e.getHTML()),
  });

  // Nilai dari luar (reset formulir, muat ulang versi terbaru setelah konflik) menggantikan isi editor.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium" onClick={() => editor?.commands.focus()}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
            <span className="sr-only"> (wajib)</span>
          </>
        ) : null}
      </span>
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-surface focus-within:outline focus-within:outline-3 focus-within:outline-primary",
          error ? "border-danger" : "border-border",
          disabled && "bg-disabled-bg",
        )}
      >
        {editor ? <Toolbar editor={editor} label={`Format ${label}`} disabled={disabled} /> : null}
        <EditorContent editor={editor} />
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ToolbarButtonSpec {
  key: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  run: () => void;
}

function Toolbar({ editor, label, disabled }: { editor: Editor; label: string; disabled?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const [dialog, setDialog] = useState<"link" | "image" | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chain = () => editor.chain().focus();

  const buttons: ToolbarButtonSpec[] = [
    { key: "bold", label: "Tebal", icon: <Bold />, active: s.bold, run: () => chain().toggleBold().run() },
    {
      key: "italic",
      label: "Miring",
      icon: <Italic />,
      active: s.italic,
      run: () => chain().toggleItalic().run(),
    },
    {
      key: "h2",
      label: "Subjudul",
      icon: <Heading2 />,
      active: s.h2,
      run: () => chain().toggleHeading({ level: 2 }).run(),
    },
    {
      key: "h3",
      label: "Sub-subjudul",
      icon: <Heading3 />,
      active: s.h3,
      run: () => chain().toggleHeading({ level: 3 }).run(),
    },
    {
      key: "bullet",
      label: "Daftar berpoin",
      icon: <List />,
      active: s.bullet,
      run: () => chain().toggleBulletList().run(),
    },
    {
      key: "ordered",
      label: "Daftar bernomor",
      icon: <ListOrdered />,
      active: s.ordered,
      run: () => chain().toggleOrderedList().run(),
    },
    {
      key: "quote",
      label: "Kutipan",
      icon: <Quote />,
      active: s.quote,
      run: () => chain().toggleBlockquote().run(),
    },
    {
      key: "link",
      label: "Sisipkan tautan",
      icon: <LinkIcon />,
      active: s.link,
      run: () => setDialog("link"),
    },
    {
      key: "unlink",
      label: "Hapus tautan",
      icon: <Unlink />,
      disabled: !s.link,
      run: () => chain().extendMarkRange("link").unsetLink().run(),
    },
    { key: "image", label: "Sisipkan gambar", icon: <ImagePlus />, run: () => setDialog("image") },
    {
      key: "undo",
      label: "Urungkan",
      icon: <Undo2 />,
      disabled: !s.canUndo,
      run: () => chain().undo().run(),
    },
    { key: "redo", label: "Ulangi", icon: <Redo2 />, disabled: !s.canRedo, run: () => chain().redo().run() },
  ];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next = focusIndex;
    if (e.key === "ArrowRight") next = (focusIndex + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (focusIndex - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-0.5 border-b border-divider bg-neutral-50 p-1"
      >
        {buttons.map((b, i) => {
          // Tombol yang sementara tidak berlaku (Urungkan tanpa riwayat, Hapus tautan tanpa tautan) tetap dapat
          // difokus dengan aria-disabled (pola bilah alat WAI-ARIA APG): perhentian Tab roving tidak pernah jatuh
          // ke tombol mati sehingga bilah alat tidak hilang dari urutan Tab, dan fokus tidak terlempar ke <body>
          // saat tombol yang sedang difokus menjadi tidak berlaku. Editor yang dinonaktifkan seluruhnya memakai
          // disabled native (tanpa perhentian Tab sama sekali).
          const unavailable = Boolean(b.disabled);
          return (
            <button
              key={b.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              aria-label={b.label}
              title={b.label}
              aria-pressed={b.active === undefined ? undefined : b.active}
              aria-disabled={!disabled && unavailable ? true : undefined}
              tabIndex={i === focusIndex ? 0 : -1}
              disabled={disabled}
              onFocus={() => setFocusIndex(i)}
              onClick={() => {
                if (!unavailable) b.run();
              }}
              className={cn(
                "inline-flex size-11 items-center justify-center rounded-sm text-text [&_svg]:size-4",
                b.active ? "bg-green-100 text-primary" : "hover:bg-neutral-100",
                "disabled:cursor-not-allowed disabled:opacity-40",
                "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
              )}
            >
              {b.icon}
            </button>
          );
        })}
      </div>
      <LinkDialog
        open={dialog === "link"}
        initial={(editor.getAttributes("link").href as string | undefined) ?? ""}
        onClose={() => setDialog(null)}
        onSubmit={(href) => {
          chain().extendMarkRange("link").setLink({ href }).run();
          setDialog(null);
        }}
      />
      <ImageDialog
        open={dialog === "image"}
        onClose={() => setDialog(null)}
        onSubmit={(src, alt) => {
          chain().setImage({ src, alt }).run();
          setDialog(null);
        }}
      />
    </>
  );
}

function LinkDialog({
  open,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSubmit: (href: string) => void;
}) {
  const [href, setHref] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setHref(initial);
      setError(null);
    }
  }, [open, initial]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Sisipkan tautan"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button
            onClick={() => {
              const v = href.trim();
              if (!SAFE_LINK.test(v)) setError("Gunakan alamat yang diawali https:// atau mailto:.");
              else onSubmit(v);
            }}
          >
            Sisipkan
          </Button>
        </>
      }
    >
      <Field label="Alamat tautan" error={error} required>
        {(a11y) => (
          <Input
            {...a11y}
            type="url"
            inputMode="url"
            placeholder="https://kapdh.or.id/..."
            value={href}
            onChange={(e) => setHref(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

function ImageDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (src: string, alt: string) => void;
}) {
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const [errors, setErrors] = useState<{ src?: string; alt?: string }>({});
  useEffect(() => {
    if (open) {
      setSrc("");
      setAlt("");
      setErrors({});
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Sisipkan gambar"
      description="Gambar harus dapat diakses publik melalui https. Teks alternatif wajib untuk pembaca layar."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button
            onClick={() => {
              const next = {
                src: SAFE_IMAGE.test(src.trim()) ? undefined : "Gunakan alamat gambar yang diawali https://.",
                alt: alt.trim() ? undefined : "Teks alternatif wajib diisi.",
              };
              setErrors(next);
              if (!next.src && !next.alt) onSubmit(src.trim(), alt.trim());
            }}
          >
            Sisipkan
          </Button>
        </>
      }
    >
      <Field label="Alamat gambar" error={errors.src} required>
        {(a11y) => <Input {...a11y} type="url" value={src} onChange={(e) => setSrc(e.target.value)} />}
      </Field>
      <Field label="Teks alternatif" hint="Jelaskan isi gambar secara singkat." error={errors.alt} required>
        {(a11y) => <Input {...a11y} value={alt} onChange={(e) => setAlt(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
