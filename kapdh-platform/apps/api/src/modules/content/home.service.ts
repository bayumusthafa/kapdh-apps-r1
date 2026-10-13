import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@kapdh/contracts";
import { categories, events, files, tickets } from "@kapdh/database";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Clock } from "../../core/adapters/clock.js";
import type { Db } from "../../core/db/types.js";
import { notFound } from "../../core/errors/app-exception.js";
import type { AuthContext } from "../../core/guards/auth-context.js";
import { MembershipKernel } from "../../core/membership/membership.kernel.js";
import { NotificationService } from "../../core/notifications-kernel/notification.service.js";
import { CLOCK, DB } from "../../core/tokens.js";
import { BannersService } from "./banners.service.js";
import { ContentMediaService } from "./content-media.service.js";
import { iso, isZeroMoney } from "./content.util.js";
import { FeedService } from "./feed.service.js";

type Home = components["schemas"]["Home"];
type HomeEvent = components["schemas"]["HomeEvent"];
type HomeEventRegistrationState = components["schemas"]["HomeEventRegistrationState"];

/** Batas daftar Beranda (kontrak `Home`: event maksimal 5, berita maksimal 5). */
export const HOME_EVENT_LIMIT = 5;
export const HOME_POST_LIMIT = 5;

type EventRow = typeof events.$inferSelect;

type SeatCounters = Pick<EventRow, "seatsTotal" | "heldQuantity" | "paidQuantity">;

/**
 * Kursi tersedia menurut proyeksi baca kursi (aturan tag Events, AC F09-1/F09-2): hold kedaluwarsa (tiket
 * `awaiting_payment` dengan `hold_expires_at <= now`) yang belum dilepas fisik oleh job expiry dianggap sudah lepas,
 * sehingga `seats_available = seats_total - paid_quantity - held_aktif` dengan
 * `held_aktif = held_quantity - hold kedaluwarsa`. Sama dengan respons daftar/detail event (satu label kartu).
 */
export function seatsAvailable(event: SeatCounters, expiredHolds: number): number {
  const activeHeld = Math.max(0, event.heldQuantity - expiredHolds);
  return Math.max(0, event.seatsTotal - event.paidQuantity - activeHeld);
}

/** Label pendaftaran kartu event (kontrak `HomeEventRegistrationState`, guideline p8). */
export function registrationState(
  event: EventRow,
  now: Date,
  expiredHolds: number,
): HomeEventRegistrationState {
  if (event.status === "closed" || now.getTime() >= event.registrationClosesAt.getTime()) return "closed";
  if (now.getTime() < event.registrationOpensAt.getTime()) return "not_yet_open";
  return seatsAvailable(event, expiredHolds) <= 0 ? "sold_out" : "open";
}

/**
 * GET /home (F-08, PRD 3.8, AC F08-2, F08-4): banner tampil dengan target terselesaikan, event mendatang (baca
 * saja dari tabel events: open/closed yang belum berakhir), berita terbaru yang sudah tampil, dan akses cepat
 * KTA/notifikasi. Daftar kosong adalah keadaan sah yang ditampilkan klien sebagai keadaan kosong yang membantu.
 */
@Injectable()
export class HomeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly bannersService: BannersService,
    private readonly feed: FeedService,
    private readonly notifications: NotificationService,
    private readonly media: ContentMediaService,
    private readonly membership: MembershipKernel,
  ) {}

  async home(auth: AuthContext): Promise<Home> {
    const now = this.clock.now();
    const [banners, upcoming, posts, member, unread] = await Promise.all([
      this.bannersService.home(now),
      this.upcomingEvents(now),
      this.feed.latest(auth.userId, HOME_POST_LIMIT),
      this.membership.effectiveStatusFor(auth.userId, { now }),
      this.notifications.unreadCount(auth.userId),
    ]);
    if (!member) throw notFound("Profil anggota tidak ditemukan.");
    return {
      banners,
      upcoming_events: upcoming,
      posts,
      quick_access: {
        unread_notification_count: unread,
        // Status yang dievaluasi AuthGuard pada request ini (PRD 2.2); cadangan dari kernel pada waktu yang sama.
        effective_status: auth.effectiveStatus ?? member.status,
        member_number: member.memberNumber,
        expires_at: iso(member.expiresAt),
      },
      generated_at: iso(now),
    };
  }

  /**
   * Event open/closed yang belum berakhir, tanpa draft/done/cancelled; urut mulai naik; maksimal 5. Baca saja:
   * hold kedaluwarsa dihitung (indeks tickets_event_id_status_idx) untuk proyeksi kursi, tidak pernah dilepas di sini.
   */
  private async upcomingEvents(now: Date): Promise<HomeEvent[]> {
    const expiredHolds = this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, events.id),
          eq(tickets.status, "awaiting_payment"),
          lte(tickets.holdExpiresAt, now),
        ),
      );
    const rows = await this.db
      .select({
        event: events,
        expiredHolds: sql<number>`(${expiredHolds})`.mapWith(Number),
        categoryId: categories.id,
        categorySlug: categories.slug,
        categoryLabel: categories.label,
        coverId: files.id,
      })
      .from(events)
      .leftJoin(categories, eq(categories.id, events.categoryId))
      .leftJoin(
        files,
        and(eq(files.id, events.coverFileId), eq(files.status, "ready"), eq(files.visibility, "public")),
      )
      .where(and(inArray(events.status, ["open", "closed"]), gt(events.endsAt, now)))
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(HOME_EVENT_LIMIT);
    return rows.map(({ event, expiredHolds: expired, categoryId, categorySlug, categoryLabel, coverId }) => ({
      id: event.id,
      title: event.title,
      cover_url: coverId ? this.media.publicUrl(coverId) : null,
      category:
        categoryId && categorySlug && categoryLabel
          ? { id: categoryId, slug: categorySlug, label: categoryLabel }
          : null,
      starts_at: iso(event.startsAt),
      ends_at: iso(event.endsAt),
      timezone: event.timezone,
      location_name: event.locationName,
      price: event.price,
      is_free: isZeroMoney(event.price),
      seats_total: event.seatsTotal,
      seats_available: seatsAvailable(event, expired),
      registration_state: registrationState(event, now, expired),
      registration_opens_at: iso(event.registrationOpensAt),
      registration_closes_at: iso(event.registrationClosesAt),
    }));
  }
}
