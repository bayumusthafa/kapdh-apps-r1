import { el, icon, ICONS } from "./dom";
import { formatCountdown } from "./format";
import {
  describeKta,
  parseKtaLocation,
  toKtaView,
  verifyKta,
  type KtaDescription,
  type KtaView,
  type Tone,
} from "./kta-verify";

/** Kelas warna per nada; status selalu disertai label dan ikon (PRD 4.5, ARCHITECTURE §2 butir 10). */
export const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  neutral: "bg-neutral-bg text-neutral",
  info: "bg-info-bg text-info",
};

const KIND_ICON: Record<Exclude<KtaView["kind"], "loading">, readonly string[]> = {
  missing: ICONS.qr,
  active: ICONS.checkCircle,
  expired: ICONS.clock,
  inactive: ICONS.ban,
  not_found: ICONS.search,
  invalid: ICONS.alert,
  unreachable: ICONS.wifiOff,
};

export interface KtaPageOptions {
  doc: Document;
  /** Wadah hasil (role=status, aria-live=polite). */
  root: HTMLElement;
  retryButton: HTMLButtonElement;
  apiBase: string;
  getLocation: () => { pathname: string; hash: string };
  fetcher?: typeof fetch;
}

function renderDescription(doc: Document, root: HTMLElement, view: KtaView, d: KtaDescription): void {
  const badgeIcon =
    view.kind === "loading"
      ? el(doc, "span", {
          class: "size-4 animate-spin rounded-full border-2 border-current border-t-transparent",
          attrs: { "aria-hidden": "true" },
        })
      : icon(doc, [...KIND_ICON[view.kind]], "size-4");
  const badge = el(
    doc,
    "p",
    {
      class: `inline-flex items-center gap-2 rounded-pill px-3 py-1 text-sm font-semibold ${TONE_CLASS[d.tone]}`,
      attrs: { "data-kta-result": view.kind },
    },
    [badgeIcon, el(doc, "span", { text: d.title })],
  );
  const header = el(doc, "div", { class: "flex items-start gap-4" });
  if (d.avatarUrl) {
    const img = el(doc, "img", {
      class: "size-20 shrink-0 rounded-full border-2 border-accent object-cover",
      attrs: {
        src: d.avatarUrl,
        alt: "Foto anggota",
        width: "80",
        height: "80",
        referrerpolicy: "no-referrer",
      },
    });
    img.addEventListener("error", () => img.remove(), { once: true });
    header.append(img);
  }
  header.append(
    el(doc, "div", { class: "flex min-w-0 flex-col gap-3" }, [
      badge,
      el(doc, "p", { class: "text-sm", text: d.detail }),
    ]),
  );
  const children: Node[] = [header];
  if (d.facts.length > 0) {
    const list = el(doc, "dl", {
      class: "grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-divider pt-4 text-sm",
    });
    for (const fact of d.facts) {
      list.append(
        el(doc, "dt", { class: "text-text-muted", text: fact.label }),
        el(doc, "dd", { class: "min-w-0 break-words font-medium", text: fact.value }),
      );
    }
    children.push(list);
  }
  if (d.checked) children.push(el(doc, "p", { class: "text-xs text-text-muted", text: d.checked }));
  root.replaceChildren(el(doc, "div", { class: "flex flex-col gap-4" }, children));
  root.setAttribute("aria-busy", view.kind === "loading" ? "true" : "false");
}

/**
 * Shell /kta/{nomor} (F-06). Loading tidak pernah menampilkan tombol coba lagi; "Tidak dapat memverifikasi"
 * selalu menawarkan coba lagi (setelah hitung mundur bila 429); hasil lain menampilkan checked_at server.
 */
export function mountKtaPage(options: KtaPageOptions): { run: () => Promise<void> } {
  const { doc, root, retryButton, apiBase } = options;
  const win = doc.defaultView;
  let running = false;
  let countdown: ReturnType<typeof setInterval> | null = null;

  const stopCountdown = () => {
    if (countdown !== null) clearInterval(countdown);
    countdown = null;
  };

  const setRetry = (visible: boolean, waitSeconds: number | null) => {
    stopCountdown();
    retryButton.hidden = !visible;
    if (!visible) {
      retryButton.disabled = true;
      return;
    }
    if (waitSeconds === null || waitSeconds <= 0) {
      retryButton.disabled = false;
      retryButton.textContent = "Coba lagi";
      return;
    }
    let left = waitSeconds;
    retryButton.disabled = true;
    retryButton.textContent = `Coba lagi (${formatCountdown(left)})`;
    countdown = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopCountdown();
        retryButton.disabled = false;
        retryButton.textContent = "Coba lagi";
      } else {
        retryButton.textContent = `Coba lagi (${formatCountdown(left)})`;
      }
    }, 1000);
  };

  const show = (view: KtaView) => {
    const d = describeKta(view);
    renderDescription(doc, root, view, d);
    setRetry(d.retry, view.kind === "unreachable" ? view.retryAfterSeconds : null);
  };

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { pathname, hash } = options.getLocation();
      const loc = parseKtaLocation(pathname, hash);
      if (loc.status === "missing") return show({ kind: "missing" });
      if (loc.status === "invalid") return show({ kind: "invalid", checkedAt: null, cause: "link" });
      show({ kind: "loading" });
      const result = await verifyKta(apiBase, loc.memberNumber, loc.token, options.fetcher);
      show(toKtaView(result));
    } finally {
      running = false;
    }
  };

  retryButton.addEventListener("click", () => void run());
  win?.addEventListener("hashchange", () => void run());
  return { run };
}
