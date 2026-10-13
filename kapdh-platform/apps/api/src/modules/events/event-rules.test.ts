import { describe, expect, it } from "vitest";
import {
  allowedActions,
  cancellationPolicy,
  checkinRejection,
  checkinRejectionCode,
  checkinWindow,
  formatEventDateTime,
  holdExpiresAt,
  isValidTimezone,
  memberCanCancel,
  memberRefundEligible,
  projectedTicketStatus,
  registrationState,
  reminderDedupKey,
  reminderDue,
  reservationBlockReason,
  seatProjection,
  statusTransitionError,
} from "./event-rules.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-13T02:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

describe("Proyeksi hold dan kursi (AC F09-1, F09-2)", () => {
  it("AC F09-2: hold awaiting_payment yang lewat tampil expired; status lain tidak berubah", () => {
    expect(projectedTicketStatus({ status: "awaiting_payment", holdExpiresAt: at(-1) }, now)).toBe("expired");
    expect(projectedTicketStatus({ status: "awaiting_payment", holdExpiresAt: now }, now)).toBe("expired");
    expect(projectedTicketStatus({ status: "awaiting_payment", holdExpiresAt: at(1) }, now)).toBe(
      "awaiting_payment",
    );
    expect(projectedTicketStatus({ status: "awaiting_review", holdExpiresAt: null }, now)).toBe(
      "awaiting_review",
    );
  });

  it("AC F09-1: seats_available = total - paid - held aktif, tidak pernah negatif", () => {
    expect(seatProjection({ seatsTotal: 10, heldQuantity: 3, paidQuantity: 4 }, 1)).toEqual({
      held: 2,
      paid: 4,
      available: 4,
    });
    expect(seatProjection({ seatsTotal: 2, heldQuantity: 2, paidQuantity: 1 }, 0).available).toBe(0);
  });

  it("D5: hold = min(now + hold_hours, registration_closes_at)", () => {
    expect(holdExpiresAt(now, 24, at(3 * DAY))).toEqual(at(24 * HOUR));
    expect(holdExpiresAt(now, 24, at(5 * HOUR))).toEqual(at(5 * HOUR));
  });
});

describe("Label pendaftaran dan alasan blokir (kontrak EventRegistrationState)", () => {
  const event = { status: "open" as const, registrationOpensAt: at(-DAY), registrationClosesAt: at(DAY) };

  it("F-09: cancelled > closed > not_yet_open > sold_out > open", () => {
    expect(registrationState({ ...event, status: "cancelled" }, 5, now)).toBe("cancelled");
    expect(registrationState({ ...event, status: "closed" }, 5, now)).toBe("closed");
    expect(registrationState({ ...event, registrationClosesAt: now }, 5, now)).toBe("closed");
    expect(registrationState({ ...event, registrationOpensAt: at(1) }, 5, now)).toBe("not_yet_open");
    expect(registrationState(event, 0, now)).toBe("sold_out");
    expect(registrationState(event, 1, now)).toBe("open");
  });

  it("F-09: urutan alasan membership_required, has_active_ticket, lalu label pendaftaran", () => {
    expect(
      reservationBlockReason({ status: "expired", hasActiveTicket: true, registration: "sold_out" }),
    ).toBe("membership_required");
    expect(
      reservationBlockReason({ status: "verified", hasActiveTicket: true, registration: "sold_out" }),
    ).toBe("has_active_ticket");
    expect(
      reservationBlockReason({ status: "expiring", hasActiveTicket: false, registration: "sold_out" }),
    ).toBe("sold_out");
    expect(
      reservationBlockReason({ status: "verified", hasActiveTicket: false, registration: "open" }),
    ).toBeNull();
  });
});

describe("Check-in (AC F09-5, F09-6, D5)", () => {
  const event = { checkinOpensAt: null, checkinClosesAt: null, startsAt: at(HOUR), endsAt: at(5 * HOUR) };
  const window = checkinWindow(event, 2);
  const base = {
    requestedEventId: "e1",
    ticket: { eventId: "e1", status: "paid" as const, holdExpiresAt: null, checkedInAt: null },
    event: { status: "open" as const },
    holder: { accountStatus: "active", suspended: false },
    window,
    now,
  };

  it("D5: jendela bawaan 2 jam sebelum mulai sampai selesai; override dihormati", () => {
    expect(window).toEqual({ opensAt: at(-HOUR), closesAt: at(5 * HOUR) });
    expect(
      checkinWindow({ ...event, checkinOpensAt: at(2 * HOUR), checkinClosesAt: at(3 * HOUR) }, 2),
    ).toEqual({
      opensAt: at(2 * HOUR),
      closesAt: at(3 * HOUR),
    });
  });

  it("AC F09-6: urutan alasan penolakan sesuai kontrak dan kode galatnya", () => {
    expect(checkinRejection(base)).toBeNull();
    expect(checkinRejection({ ...base, requestedEventId: "e2" })).toBe("other_event");
    expect(checkinRejection({ ...base, event: { status: "cancelled" } })).toBe("event_cancelled");
    expect(checkinRejection({ ...base, ticket: { ...base.ticket, status: "cancelled" } })).toBe(
      "ticket_cancelled",
    );
    expect(
      checkinRejection({
        ...base,
        ticket: { ...base.ticket, status: "awaiting_payment", holdExpiresAt: at(-1) },
      }),
    ).toBe("ticket_expired");
    expect(
      checkinRejection({
        ...base,
        ticket: { ...base.ticket, status: "awaiting_payment", holdExpiresAt: at(1) },
      }),
    ).toBe("ticket_awaiting_payment");
    expect(checkinRejection({ ...base, ticket: { ...base.ticket, checkedInAt: at(-1) } })).toBe(
      "already_checked_in",
    );
    expect(checkinRejection({ ...base, holder: { accountStatus: "active", suspended: true } })).toBe(
      "holder_ineligible",
    );
    expect(checkinRejection({ ...base, holder: { accountStatus: null, suspended: false } })).toBe(
      "holder_ineligible",
    );
    expect(checkinRejection({ ...base, now: at(-2 * HOUR) })).toBe("too_early");
    expect(checkinRejection({ ...base, now: at(6 * HOUR) })).toBe("too_late");
    expect(checkinRejection({ ...base, event: { status: "done" } })).toBe("too_late");
    expect(checkinRejectionCode("already_checked_in")).toBe("TICKET_ALREADY_CHECKED_IN");
    expect(checkinRejectionCode("ticket_expired")).toBe("RESERVATION_EXPIRED");
    expect(checkinRejectionCode("ticket_awaiting_review")).toBe("PAYMENT_STATE_CONFLICT");
    expect(checkinRejectionCode("too_early")).toBe("VALIDATION_ERROR");
  });
});

describe("Pembatalan dan refund D6", () => {
  const event = { status: "open" as const, startsAt: at(10 * DAY) };
  const paid = { status: "paid" as const, holdExpiresAt: null, checkedInAt: null, totalSnapshot: "75000.00" };

  it("D6: refund penuh sampai sebelum H-3; sesudahnya batal tanpa refund; gratis tanpa refund; awaiting_review tidak dapat dibatalkan", () => {
    expect(memberRefundEligible(paid, event, now, 3)).toBe(true);
    expect(memberRefundEligible(paid, event, at(7 * DAY), 3)).toBe(false);
    expect(memberCanCancel(paid, event, at(7 * DAY))).toBe(true);
    expect(memberRefundEligible({ ...paid, totalSnapshot: "0.00" }, event, now, 3)).toBe(false);
    expect(memberCanCancel({ ...paid, status: "awaiting_review" }, event, now)).toBe(false);
    expect(memberCanCancel(paid, event, at(10 * DAY))).toBe(false);
    expect(memberCanCancel({ ...paid, checkedInAt: now }, event, now)).toBe(false);
  });

  it("D6: ringkasan kebijakan memakai zona waktu event dan H-3", () => {
    const policy = cancellationPolicy(
      { startsAt: new Date("2026-10-15T02:00:00Z"), timezone: "Asia/Jakarta", price: "75000.00" },
      { self_cancel_days: 3 },
    );
    expect(policy.full_refund_until).toBe("2026-10-12T02:00:00.000Z");
    expect(policy.summary).toBe(
      "Batalkan sampai 12 Okt 2026 09.00 WIB (H-3) untuk refund penuh; setelah itu tanpa refund. Refund ditransfer bendahara paling lambat 7 hari kerja.",
    );
    expect(formatEventDateTime(new Date("2026-10-12T02:00:00Z"), "Asia/Makassar")).toBe(
      "12 Okt 2026 10.00 WITA",
    );
    expect(isValidTimezone("Asia/Jayapura")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });
});

describe("Siklus event dan pengingat (PRD 4.4, AC F13-6)", () => {
  it("PRD 4.4: transisi publish/close/reopen dan aksi yang diizinkan", () => {
    const draft = { status: "draft" as const, endsAt: at(DAY), registrationClosesAt: at(HOUR) };
    expect(statusTransitionError(draft, "open", now)).toBeNull();
    expect(statusTransitionError({ ...draft, registrationClosesAt: at(-1) }, "open", now)).not.toBeNull();
    expect(statusTransitionError(draft, "closed", now)).not.toBeNull();
    expect(statusTransitionError({ ...draft, status: "done" }, "open", now)).not.toBeNull();
    expect(allowedActions(draft, false, now)).toEqual(["edit", "publish", "delete"]);
    expect(allowedActions({ ...draft, status: "open" }, true, now)).toEqual(["edit", "close", "cancel"]);
    expect(allowedActions({ ...draft, status: "cancelled" }, true, now)).toEqual([]);
  });

  it("AC F13-6: H-3 lalu H-1; kunci dedup berubah bila jadwal berubah", () => {
    expect(reminderDue(at(4 * DAY), now)).toBeNull();
    expect(reminderDue(at(3 * DAY), now)).toBe("h3");
    expect(reminderDue(at(DAY), now)).toBe("h1");
    expect(reminderDue(at(-1), now)).toBeNull();
    expect(reminderDedupKey("e", "h3", at(DAY))).not.toBe(reminderDedupKey("e", "h3", at(2 * DAY)));
  });
});
