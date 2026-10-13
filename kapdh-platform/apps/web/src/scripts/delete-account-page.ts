import { newIdempotencyKey, type ApiFailure } from "./api";
import { applySupport } from "./config-page";
import { fetchPublicConfigTimed, serverOffsetMs, type PublicConfig, type TimedConfig } from "./config";
import {
  confirmDeletion,
  deletionFacts,
  describeFailure,
  disclosureWarnings,
  resendChallenge,
  retentionSummary,
  startChallenge,
  toVerifyOutcome,
  validateCode,
  validateEmail,
  verifyChallenge,
  type AccountDeletion,
  type AccountDeletionDisclosure,
  type FailureView,
  type OtpChallenge,
} from "./delete-account";
import { el, icon, ICONS } from "./dom";
import { formatCountdown, secondsUntil } from "./format";
import { createOtpInput, type OtpInput } from "./otp-input";

/**
 * Alur /delete-account tanpa aplikasi (F-14, R2): email -> kode OTP -> pengungkapan D2 dan peringatan refund ->
 * konfirmasi eksplisit -> nomor permintaan (AC F14-1). Akun yang sudah deletion_pending melihat status permintaan;
 * akun disabled diarahkan ke bantuan (PRD 2.2). Token penghapusan dan kode hanya ada di memori halaman.
 */

const OTP_VALIDITY_MS = 10 * 60_000; // PRD 2.5
const RESEND_COOLDOWN_MAX_S = 60; // PRD 2.5
const TOKEN_VALIDITY_MAX_S = 10 * 60; // F-14: reautentikasi maksimal 10 menit

type Step = "email" | "code" | "confirm" | "done" | "status" | "disabled";

const STEP_LABELS = ["Email", "Verifikasi", "Konfirmasi", "Selesai"] as const;
const STEP_INDEX: Partial<Record<Step, number>> = { email: 0, code: 1, confirm: 2, done: 3 };

export interface DeleteAccountOptions {
  doc: Document;
  root: HTMLElement;
  apiBase: string;
  fetcher?: typeof fetch;
  /** Jam perangkat (ms). */
  now?: () => number;
  newKey?: () => string;
  /** GET /public/config yang sudah dimulai halaman (dipakai bersama banner maintenance). */
  config?: Promise<TimedConfig>;
}

interface Deletable {
  disclosure: AccountDeletionDisclosure;
  token: string;
  tokenExpiresAt: string;
  registrationPending: boolean;
  emailMasked: string;
}

export function mountDeleteAccount(options: DeleteAccountOptions) {
  const { doc, root, apiBase, fetcher } = options;
  const now = options.now ?? (() => Date.now());
  const newKey = options.newKey ?? (() => newIdempotencyKey());

  const state = {
    step: "email" as Step,
    email: "",
    challenge: null as OtpChallenge | null,
    attemptsLeft: 0,
    deletable: null as Deletable | null,
    idempotencyKey: null as string | null,
    deletion: null as AccountDeletion | null,
    emailMasked: "",
    config: null as PublicConfig | null,
    /** Selisih jam server - perangkat (ms); null bila belum diketahui. */
    offsetMs: null as number | null,
    waitUntil: null as number | null,
    busy: false,
  };

  const serverNow = () => now() + (state.offsetMs ?? 0);

  // ---- Kerangka: langkah, wilayah pesan, wadah langkah ----
  const stepper = el(doc, "ol", { class: "del-steps", attrs: { "aria-label": "Langkah penghapusan akun" } });
  const stepItems = STEP_LABELS.map((label, i) => {
    const item = el(doc, "li", { class: "del-step", attrs: { "data-state": "todo" } }, [
      el(doc, "span", { class: "del-step-dot", attrs: { "aria-hidden": "true" }, text: String(i + 1) }),
      el(doc, "span", { class: "del-step-label", text: label }),
    ]);
    stepper.append(item);
    return item;
  });
  const alertBox = el(doc, "div", { class: "alert-danger", attrs: { role: "alert", "data-del-alert": "" } });
  alertBox.hidden = true;
  const notice = el(doc, "p", { class: "alert-success", attrs: { role: "status", "data-del-notice": "" } });
  notice.hidden = true;
  const container = el(doc, "div", { class: "flex flex-col gap-6" });
  root.replaceChildren(
    el(doc, "div", { class: "flex flex-col gap-6" }, [stepper, alertBox, notice, container]),
  );

  // Elemen yang diperbarui setiap detik oleh tick().
  let otp: OtpInput | null = null;
  let primaryButton: HTMLButtonElement | null = null;
  let primaryLabel = "";
  let resendButton: HTMLButtonElement | null = null;
  let expiryText: HTMLElement | null = null;
  let attemptsText: HTMLElement | null = null;
  let tokenText: HTMLElement | null = null;
  let alertBase = "";

  const showAlert = (message: string) => {
    alertBase = message;
    alertBox.textContent = message;
    alertBox.hidden = false;
  };
  const clearAlert = () => {
    alertBase = "";
    alertBox.hidden = true;
    alertBox.textContent = "";
  };
  const showNotice = (message: string) => {
    notice.textContent = message;
    notice.hidden = false;
  };
  const clearNotice = () => {
    notice.hidden = true;
    notice.textContent = "";
  };

  const waitSeconds = () =>
    state.waitUntil === null ? 0 : Math.max(0, Math.ceil((state.waitUntil - now()) / 1000));

  /** Tombol yang dimatikan selama request berjalan; dinyalakan lagi setelahnya (tick() menerapkan ulang jeda). */
  let busyDisabled: HTMLButtonElement[] = [];
  const setBusy = (busy: boolean, busyLabel?: string) => {
    state.busy = busy;
    root.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      busyDisabled = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) => !b.disabled,
      );
      for (const button of busyDisabled) button.disabled = true;
      otp?.setDisabled(true);
      if (primaryButton && busyLabel) primaryButton.textContent = busyLabel;
      return;
    }
    for (const button of busyDisabled) button.disabled = false;
    busyDisabled = [];
    otp?.setDisabled(false);
    tick();
  };

  const heading = (id: string, text: string) =>
    el(doc, "h2", { class: "font-heading text-h2 font-semibold", text, attrs: { id, tabindex: "-1" } });

  const supportBlock = () => {
    const block = el(doc, "div", { class: "info-box flex flex-col gap-1 text-sm" }, [
      el(doc, "span", { text: "Bantuan KAPDH:" }),
      el(doc, "a", {
        class: "font-semibold text-primary underline",
        attrs: { "data-support-email": "", href: "mailto:bantuan@kapdh.or.id" },
        text: "bantuan@kapdh.or.id",
      }),
      el(doc, "span", { attrs: { "data-support-whatsapp": "" } }, [
        "WhatsApp: ",
        el(doc, "a", {
          class: "font-semibold text-primary underline",
          attrs: { target: "_blank", rel: "noopener noreferrer" },
        }),
      ]),
    ]);
    return block;
  };

  const factsList = (facts: Array<{ label: string; value: string }>) => {
    const list = el(doc, "dl", {
      class: "grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg bg-surface p-4 text-sm shadow-card",
    });
    for (const f of facts) {
      list.append(
        el(doc, "dt", { class: "text-text-muted", text: f.label }),
        el(doc, "dd", {
          class: "min-w-0 break-words font-semibold",
          text: f.value,
          attrs: { "data-fact": f.label },
        }),
      );
    }
    return list;
  };

  const updateStepper = () => {
    const current = STEP_INDEX[state.step];
    stepper.hidden = current === undefined;
    stepItems.forEach((item, i) => {
      const s = current === undefined ? "todo" : i < current ? "done" : i === current ? "current" : "todo";
      item.dataset.state = s;
      if (s === "current") item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  };

  // ---- Pembaruan per detik: hitung mundur OTP, kirim ulang, token, dan 429 ----
  const tick = () => {
    const wait = waitSeconds();
    if (state.waitUntil !== null && wait === 0) {
      state.waitUntil = null;
      if (alertBase) alertBox.textContent = "Silakan coba lagi sekarang.";
    } else if (wait > 0) {
      alertBox.textContent = `${alertBase} Coba lagi dalam ${formatCountdown(wait)}.`;
    }
    if (primaryButton && !state.busy) {
      primaryButton.disabled = wait > 0;
      primaryButton.textContent = primaryLabel;
    }
    if (state.step === "code" && state.challenge) {
      // Dibatasi nilai PRD 2.5 agar jam perangkat yang menyimpang tidak mengunci tombol terlalu lama.
      const expiry = secondsUntil(state.challenge.expires_at, serverNow(), OTP_VALIDITY_MS / 1000);
      if (expiryText) {
        expiryText.textContent =
          expiry > 0
            ? `Kode berlaku ${formatCountdown(expiry)} lagi.`
            : "Kode sudah kedaluwarsa. Kirim ulang untuk mendapatkan kode baru.";
      }
      if (attemptsText)
        attemptsText.textContent = `Sisa percobaan: ${state.attemptsLeft} dari ${state.challenge.max_attempts ?? 5}`;
      if (resendButton && !state.busy) {
        const cooldown = secondsUntil(
          state.challenge.resend_available_at,
          serverNow(),
          RESEND_COOLDOWN_MAX_S,
        );
        const blocked = Math.max(cooldown, wait);
        resendButton.disabled = blocked > 0;
        resendButton.textContent =
          blocked > 0 ? `Kirim ulang dalam ${formatCountdown(blocked)}` : "Kirim ulang kode";
      }
    }
    if (state.step === "confirm" && state.deletable && tokenText) {
      const left = secondsUntil(state.deletable.tokenExpiresAt, serverNow(), TOKEN_VALIDITY_MAX_S);
      tokenText.textContent =
        left > 0
          ? `Konfirmasi dalam ${formatCountdown(left)} sebelum verifikasi email berakhir.`
          : "Waktu konfirmasi 10 menit sudah habis. Bila konfirmasi ditolak, verifikasi email Anda lagi.";
    }
    if (resendButton && state.busy) resendButton.disabled = true;
  };

  const handleWait = (failure: FailureView) => {
    if (failure.action === "wait" && failure.retryAfterSeconds) {
      state.waitUntil = now() + failure.retryAfterSeconds * 1000;
    }
    showAlert(failure.message);
    tick();
  };

  // ---- Langkah ----
  const enter = (step: Step, opts: { focus?: boolean } = {}) => {
    state.step = step;
    otp = null;
    primaryButton = null;
    resendButton = null;
    expiryText = null;
    attemptsText = null;
    tokenText = null;
    const section = renderStep(step);
    container.replaceChildren(section);
    updateStepper();
    applySupport(doc, state.config);
    tick();
    if (opts.focus !== false) section.querySelector<HTMLElement>("h2")?.focus();
  };

  const restart = (message: string | null) => {
    state.challenge = null;
    state.deletable = null;
    state.idempotencyKey = null;
    clearNotice();
    enter("email");
    if (message) showAlert(message);
    else clearAlert();
  };

  const renderStep = (step: Step): HTMLElement => {
    switch (step) {
      case "email":
        return renderEmail();
      case "code":
        return renderCode();
      case "confirm":
        return renderConfirm();
      case "done":
        return renderDone();
      case "status":
        return renderStatus();
      case "disabled":
        return renderDisabled();
    }
  };

  const renderEmail = () => {
    const input = el(doc, "input", {
      class: "field-input",
      attrs: {
        id: "del-email",
        name: "email",
        type: "email",
        autocomplete: "email",
        inputmode: "email",
        maxlength: "254",
        required: "",
        "aria-describedby": "del-email-error",
      },
    });
    input.value = state.email;
    const error = el(doc, "p", { class: "field-error", attrs: { id: "del-email-error" } });
    error.hidden = true;
    primaryLabel = "Kirim kode verifikasi";
    primaryButton = el(doc, "button", {
      class: "btn-primary",
      text: primaryLabel,
      attrs: { type: "submit" },
    });
    const form = el(
      doc,
      "form",
      { class: "flex flex-col gap-4", attrs: { method: "post", novalidate: "" } },
      [
        el(doc, "div", { class: "flex flex-col gap-1.5" }, [
          el(doc, "label", { class: "text-sm font-medium", text: "Email akun", attrs: { for: "del-email" } }),
          input,
          error,
        ]),
        primaryButton,
      ],
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.busy || waitSeconds() > 0) return;
      const checked = validateEmail(input.value);
      if ("error" in checked) {
        error.textContent = checked.error;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      error.hidden = true;
      input.removeAttribute("aria-invalid");
      state.email = checked.email;
      void sendChallenge();
    });
    const sendChallenge = async () => {
      clearAlert();
      clearNotice();
      setBusy(true, "Mengirim kode…");
      const result = await startChallenge(apiBase, state.email, fetcher);
      setBusy(false);
      if (result.ok) {
        acceptChallenge(result.data);
        enter("code");
        return;
      }
      const failure = describeFailure("challenge", result);
      if (failure.action === "fix") {
        error.textContent = failure.message;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      handleWait(failure);
    };
    return el(
      doc,
      "section",
      { class: "flex flex-col gap-4", attrs: { "aria-labelledby": "del-h-email", "data-step": "email" } },
      [
        heading("del-h-email", "Masukkan email akun"),
        el(doc, "p", {
          class: "text-sm text-text-muted",
          text: "Kami mengirim kode verifikasi 6 digit ke email akun KAPDH Anda. Langkah yang sama dipakai untuk memeriksa status permintaan penghapusan yang sudah diajukan.",
        }),
        form,
      ],
    );
  };

  const acceptChallenge = (challenge: OtpChallenge) => {
    state.challenge = challenge;
    state.attemptsLeft = challenge.attempts_left;
    if (state.offsetMs === null) {
      // Tanpa jam server dari /public/config: kode baru berlaku tepat 10 menit sejak terbit (PRD 2.5).
      state.offsetMs = Date.parse(challenge.expires_at) - OTP_VALIDITY_MS - now();
    }
  };

  const renderCode = () => {
    const errorText = el(doc, "p", { class: "field-error", attrs: { id: "del-code-error" } });
    errorText.hidden = true;
    primaryLabel = "Verifikasi";
    primaryButton = el(doc, "button", {
      class: "btn-primary",
      text: primaryLabel,
      attrs: { type: "submit" },
    });
    const verifyButton = primaryButton;
    otp = createOtpInput(doc, { legend: "Kode OTP", onComplete: () => verifyButton.focus() });
    const input = otp;
    attemptsText = el(doc, "p", { class: "text-xs text-text-muted", attrs: { "data-attempts": "" } });
    expiryText = el(doc, "p", { class: "text-xs text-text-muted", attrs: { "data-expiry": "" } });
    resendButton = el(doc, "button", {
      class: "btn-link",
      text: "Kirim ulang kode",
      attrs: { type: "button", "data-resend": "" },
    });
    const changeEmail = el(doc, "button", {
      class: "btn-link self-start",
      text: "Salah email? Ubah alamat email",
      attrs: { type: "button" },
    });
    const form = el(
      doc,
      "form",
      { class: "flex flex-col gap-4", attrs: { method: "post", novalidate: "" } },
      [
        input.element,
        errorText,
        attemptsText,
        expiryText,
        el(doc, "div", { class: "info-box flex flex-wrap items-center justify-between gap-3" }, [
          el(doc, "span", { class: "text-sm", text: "Tidak menerima kode?" }),
          resendButton,
        ]),
        changeEmail,
        primaryButton,
      ],
    );
    const showCodeError = (message: string) => {
      errorText.textContent = message;
      errorText.hidden = false;
      input.setInvalid(true, "del-code-error");
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.busy || waitSeconds() > 0 || !state.challenge) return;
      const checked = validateCode(input.value());
      if ("error" in checked) {
        showCodeError(checked.error);
        input.focus();
        return;
      }
      errorText.hidden = true;
      input.setInvalid(false);
      void verify(checked.code);
    });
    const verify = async (code: string) => {
      clearAlert();
      clearNotice();
      setBusy(true, "Memverifikasi…");
      const result = await verifyChallenge(apiBase, state.challenge!.challenge_id, code, fetcher);
      setBusy(false);
      if (result.ok) {
        const outcome = toVerifyOutcome(result.data);
        state.emailMasked = outcome.emailMasked;
        state.challenge = null;
        if (outcome.kind === "deletable") {
          state.deletable = {
            disclosure: outcome.disclosure,
            token: outcome.token,
            tokenExpiresAt: outcome.tokenExpiresAt,
            registrationPending: outcome.registrationPending,
            emailMasked: outcome.emailMasked,
          };
          state.idempotencyKey = newKey();
          enter("confirm");
        } else if (outcome.kind === "in_progress") {
          state.deletion = outcome.deletion;
          enter("status");
        } else {
          enter("disabled");
        }
        return;
      }
      const failure = describeFailure("verify", result);
      // Kode hanya dikosongkan bila ditolak server; galat jaringan/429 mempertahankannya untuk coba lagi.
      if (failure.action === "fix") {
        input.clear();
        state.attemptsLeft = Math.max(0, state.attemptsLeft - 1);
        showCodeError(failure.message);
        tick();
        input.focus();
        return;
      }
      if (failure.action === "resend") {
        input.clear();
        state.attemptsLeft = 0;
        showCodeError(failure.message);
        tick();
        resendButton?.focus();
        return;
      }
      handleWait(failure);
    };
    resendButton.addEventListener("click", () => void resend());
    const resend = async () => {
      if (state.busy || !state.challenge) return;
      clearAlert();
      clearNotice();
      setBusy(true);
      const result = await resendChallenge(apiBase, state.challenge.challenge_id, fetcher);
      setBusy(false);
      if (result.ok) {
        acceptChallenge(result.data);
        input.clear();
        errorText.hidden = true;
        input.setInvalid(false);
        showNotice("Kode baru sudah dikirim. Kode sebelumnya tidak berlaku lagi.");
        tick();
        input.focus();
        return;
      }
      const failure = describeFailure("resend", result);
      if (failure.action === "restart") return restart(failure.message);
      handleWait(failure);
    };
    changeEmail.addEventListener("click", () => {
      if (state.busy) return;
      restart(null);
    });
    return el(
      doc,
      "section",
      { class: "flex flex-col gap-4", attrs: { "aria-labelledby": "del-h-code", "data-step": "code" } },
      [
        heading("del-h-code", "Masukkan kode verifikasi"),
        el(doc, "p", { class: "text-sm text-text-muted" }, [
          "Bila ",
          el(doc, "strong", { class: "font-semibold text-text", text: state.email }),
          " terdaftar, kode 6 digit sudah dikirim ke email tersebut. Kode berlaku 10 menit; periksa juga folder spam.",
        ]),
        form,
      ],
    );
  };

  const renderConfirm = () => {
    const d = state.deletable!;
    const disclosure = d.disclosure;
    const pending = d.registrationPending;
    const parts: Node[] = [
      heading(
        "del-h-confirm",
        pending ? "Batalkan pendaftaran dan hapus data" : "Konfirmasi penghapusan akun",
      ),
      el(doc, "p", { class: "text-sm text-text-muted" }, [
        "Email terverifikasi: ",
        el(doc, "strong", { class: "font-semibold text-text", text: d.emailMasked }),
        ".",
      ]),
    ];
    if (pending) {
      parts.push(
        el(doc, "p", {
          class: "info-box text-sm",
          text: "Pendaftaran dengan email ini belum pernah diverifikasi. Konfirmasi membatalkan pendaftaran dan menghapus datanya; nomor anggota tidak pernah dibuat. Email ini dapat dipakai mendaftar lagi setelah permintaan selesai.",
        }),
      );
    }
    for (const warning of disclosureWarnings(disclosure)) {
      const list = el(doc, "ul", { class: "list-disc space-y-1 pl-5 text-sm" });
      for (const line of warning.lines) list.append(el(doc, "li", { text: line }));
      parts.push(
        el(
          doc,
          "div",
          {
            class: "warning-box flex flex-col gap-2",
            attrs: { role: "note", "data-warning": warning.title },
          },
          [
            el(doc, "p", { class: "flex items-center gap-2 font-semibold" }, [
              icon(doc, [...ICONS.alert]),
              warning.title,
            ]),
            list,
          ],
        ),
      );
    }
    const listOf = (items: string[]) => {
      const list = el(doc, "ul", { class: "list-disc space-y-1 pl-5 text-sm" });
      for (const text of items) list.append(el(doc, "li", { text }));
      return list;
    };
    const slug = /^[a-z0-9-]{1,120}$/.test(disclosure.privacy_policy_slug)
      ? disclosure.privacy_policy_slug
      : "kebijakan-privasi";
    parts.push(
      el(doc, "div", { class: "card flex flex-col gap-4 p-5" }, [
        el(doc, "h3", { class: "font-semibold", text: "Data yang dihapus" }),
        listOf(disclosure.deleted_data.map((item) => item.description)),
        el(doc, "h3", { class: "font-semibold", text: "Data yang tetap ada dalam bentuk anonim" }),
        listOf(disclosure.retained_data.map((item) => item.description)),
        el(doc, "h3", { class: "font-semibold", text: "Penyimpanan setelah penghapusan" }),
        listOf(retentionSummary(disclosure)),
        el(doc, "p", { class: "text-sm" }, [
          "Rincian lengkap ada di ",
          el(doc, "a", {
            class: "font-semibold text-primary underline",
            text: disclosure.privacy_policy_version
              ? `Kebijakan Privasi versi ${disclosure.privacy_policy_version}`
              : "Kebijakan Privasi",
            attrs: { href: `/${slug}`, target: "_blank", rel: "noopener" },
          }),
          ".",
        ]),
      ]),
    );
    const check = el(doc, "input", {
      class: "mt-0.5 size-5 shrink-0 accent-danger",
      attrs: { id: "del-ack", type: "checkbox", "aria-describedby": "del-ack-error" },
    });
    const checkError = el(doc, "p", { class: "field-error", attrs: { id: "del-ack-error" } });
    checkError.hidden = true;
    tokenText = el(doc, "p", { class: "text-xs text-text-muted", attrs: { "data-token-expiry": "" } });
    primaryLabel = pending ? "Batalkan pendaftaran dan hapus data" : "Hapus akun saya";
    primaryButton = el(doc, "button", { class: "btn-danger", text: primaryLabel, attrs: { type: "submit" } });
    const cancel = el(doc, "button", { class: "btn-ghost", text: "Batal", attrs: { type: "button" } });
    const form = el(
      doc,
      "form",
      { class: "flex flex-col gap-4", attrs: { method: "post", novalidate: "" } },
      [
        el(doc, "label", { class: "flex items-start gap-3 text-sm font-medium", attrs: { for: "del-ack" } }, [
          check,
          el(doc, "span", {
            text: pending
              ? "Saya mengerti pendaftaran ini dibatalkan dan datanya dihapus permanen."
              : "Saya mengerti akun beserta data di atas dihapus permanen dan tidak dapat dibatalkan.",
          }),
        ]),
        checkError,
        tokenText,
        el(doc, "div", { class: "flex flex-col gap-3 sm:flex-row-reverse sm:justify-start" }, [
          primaryButton,
          cancel,
        ]),
      ],
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.busy || waitSeconds() > 0) return;
      if (!check.checked) {
        checkError.textContent = "Centang pernyataan di atas untuk melanjutkan.";
        checkError.hidden = false;
        check.setAttribute("aria-invalid", "true");
        check.focus();
        return;
      }
      checkError.hidden = true;
      check.removeAttribute("aria-invalid");
      void confirm();
    });
    const confirm = async () => {
      const current = state.deletable!;
      clearAlert();
      clearNotice();
      setBusy(true, "Memproses…");
      state.idempotencyKey ??= newKey();
      const result = await confirmDeletion(
        apiBase,
        {
          deletionToken: current.token,
          disclosureVersion: current.disclosure.version,
          idempotencyKey: state.idempotencyKey,
        },
        fetcher,
      );
      setBusy(false);
      if (result.ok) {
        state.deletion = result.data;
        state.deletable = { ...current, token: "" };
        state.idempotencyKey = null;
        enter("done");
        return;
      }
      handleConfirmFailure(describeFailure("confirm", result), result);
    };
    cancel.addEventListener("click", () => {
      if (state.busy) return;
      restart(null);
      showNotice("Penghapusan dibatalkan. Akun Anda tidak berubah.");
    });
    parts.push(form);
    return el(
      doc,
      "section",
      { class: "flex flex-col gap-5", attrs: { "aria-labelledby": "del-h-confirm", "data-step": "confirm" } },
      parts,
    );
  };

  const handleConfirmFailure = (failure: FailureView, result: ApiFailure) => {
    if (failure.action === "review" && failure.disclosure && state.deletable) {
      state.deletable = { ...state.deletable, disclosure: failure.disclosure };
      state.idempotencyKey = newKey();
      enter("confirm");
      showAlert(failure.message);
      return;
    }
    if (failure.action === "restart") return restart(failure.message);
    if (result.kind === "http" && result.status === 409) state.idempotencyKey = newKey();
    handleWait(failure);
  };

  const renderDone = () => {
    const deletion = state.deletion!;
    const pending = state.deletable?.registrationPending ?? false;
    state.deletable = null;
    return el(
      doc,
      "section",
      { class: "flex flex-col gap-4", attrs: { "aria-labelledby": "del-h-done", "data-step": "done" } },
      [
        el(
          doc,
          "p",
          {
            class:
              "inline-flex items-center gap-2 self-start rounded-pill bg-success-bg px-3 py-1 text-sm font-semibold text-success",
          },
          [icon(doc, [...ICONS.checkCircle], "size-4"), "Permintaan diterima"],
        ),
        heading("del-h-done", pending ? "Pendaftaran dibatalkan" : "Permintaan penghapusan diterima"),
        el(doc, "p", {
          class: "text-sm",
          text: pending
            ? "Data pendaftaran Anda akan dihapus. Simpan nomor permintaan berikut untuk menghubungi bantuan bila perlu."
            : "Akun Anda kini menunggu penghapusan dan semua sesi di aplikasi sudah dikeluarkan. Simpan nomor permintaan berikut untuk menghubungi bantuan.",
        }),
        factsList(deletionFacts(deletion)),
        el(doc, "p", {
          class: "text-sm text-text-muted",
          text: "Email konfirmasi berisi nomor permintaan dikirim ke alamat akun. Anda dapat memeriksa status kapan saja dengan memasukkan email yang sama di halaman ini.",
        }),
        el(doc, "a", { class: "btn-outline self-start", text: "Kembali ke beranda", attrs: { href: "/" } }),
      ],
    );
  };

  const renderStatus = () => {
    const parts: Node[] = [
      el(
        doc,
        "p",
        {
          class:
            "inline-flex items-center gap-2 self-start rounded-pill bg-info-bg px-3 py-1 text-sm font-semibold text-info",
        },
        [icon(doc, [...ICONS.clock], "size-4"), "Penghapusan sedang berjalan"],
      ),
      heading("del-h-status", "Status permintaan penghapusan"),
      el(doc, "p", { class: "text-sm" }, [
        "Akun dengan email ",
        el(doc, "strong", { class: "font-semibold", text: state.emailMasked }),
        " sudah dalam proses penghapusan. Tidak ada tindakan lain yang diperlukan.",
      ]),
    ];
    parts.push(
      state.deletion
        ? factsList(deletionFacts(state.deletion))
        : el(doc, "p", {
            class: "text-sm text-text-muted",
            text: "Rincian permintaan belum tersedia. Hubungi bantuan dengan menyebutkan email akun Anda.",
          }),
    );
    parts.push(supportBlock());
    return el(
      doc,
      "section",
      { class: "flex flex-col gap-4", attrs: { "aria-labelledby": "del-h-status", "data-step": "status" } },
      parts,
    );
  };

  const renderDisabled = () =>
    el(
      doc,
      "section",
      {
        class: "flex flex-col gap-4",
        attrs: { "aria-labelledby": "del-h-disabled", "data-step": "disabled" },
      },
      [
        el(
          doc,
          "p",
          {
            class:
              "inline-flex items-center gap-2 self-start rounded-pill bg-neutral-bg px-3 py-1 text-sm font-semibold text-neutral",
          },
          [icon(doc, [...ICONS.ban], "size-4"), "Akun dinonaktifkan"],
        ),
        heading("del-h-disabled", "Hubungi bantuan KAPDH"),
        el(doc, "p", {
          class: "text-sm",
          text: `Akun dengan email ${state.emailMasked} sedang dinonaktifkan, sehingga penghapusan tidak dapat diajukan dari halaman ini. Pemulihan atau penghapusan akun dilakukan melalui kanal bantuan.`,
        }),
        supportBlock(),
      ],
    );

  // ---- Mulai ----
  enter("email", { focus: false });
  const interval = setInterval(tick, 1000);

  const configReady = (async () => {
    const { result, sentAt, receivedAt } = await (options.config ??
      fetchPublicConfigTimed(apiBase, fetcher, now));
    if (!result.ok) return;
    state.config = result.data;
    const offset = serverOffsetMs(result.data.server_time, sentAt, receivedAt);
    if (offset !== null) state.offsetMs = offset;
    applySupport(doc, state.config);
    tick();
  })();

  return {
    configReady,
    destroy: () => clearInterval(interval),
    /** Untuk uji: langkah aktif. */
    currentStep: () => state.step,
  };
}
