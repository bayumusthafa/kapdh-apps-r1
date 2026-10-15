# KAPDH Apps — Architecture and Engineering Contract

Status: binding for every contributor and AI agent in the R1.0 build. Source of product truth is the PRD
(`docs/PRD_KAPDH_Apps_v3.5.pdf`, text copy `docs/reference/PRD_v3.5.txt`). This document records the engineering
decisions that turn the PRD into code. When this document and existing code disagree, this document wins. When this
document and the PRD disagree on product behaviour, the PRD wins — report the conflict instead of guessing.

Reference material:

- PRD text: `docs/reference/PRD_v3.5.txt` (section 3 = features/AC, 4 = flows/states, 5 = architecture, 6 = data).
- Approved prototype screens (HTML, inline styles = exact visual spec): `docs/reference/prototype/screen_*.html`.
- Brand guideline mockups (PNG, read them with the Read tool): `docs/reference/guidelines/page-01.png … page-18.png`
  (p5 login/register, p6 KTA, p7 jejaring, p8 event/tiket, p10–17 web admin).
- Brand logo: `docs/reference/prototype/logo.png` (also `kapdh-mobile/assets/logo-kapdh.png`, `kapdh-platform/apps/web/public/logo-kapdh.png`).

---

## 1. Repository and toolchain

```
KAPDHAPPS/                      single git repo, branch main (ADR-001)
  docs/                         PRD, ARCHITECTURE.md (this), BUILD_PLAN.md, adr/, runbooks/, reference/
  kapdh-platform/               pnpm 10 + turbo monorepo (Node 24)
    apps/api                    NestJS 11 + Fastify: REST /api/v1, Socket.IO gateway, domain services, job processors
    apps/worker                 thin runtime: outbox dispatcher, BullMQ consumers, schedulers (uses @kapdh/api/worker)
    apps/admin                  React 19 + Vite + TanStack Router/Query/Table + Tailwind 4 web admin
    apps/web                    Astro static public site (kapdh.or.id)
    packages/shared             TS enums, error→UI catalog, status routes, password rules (pure, isomorphic)
    packages/contracts          OpenAPI 3.1 (root.yaml + domains/*.yaml), realtime event schemas, TS types, Dart SDK generator
    packages/database           Drizzle schema (schema "app"), SQL migrations, seeds
    packages/storage            StorageDriver (local disk, S3-compatible, fallback read during migration)
    packages/config             env validation (api / worker / shared)
    packages/design-tokens      tokens.json → Tailwind CSS theme + Dart tokens
    infra/                      Dockerfiles, compose (dev + production fallback), nginx, CI, backup/restore (backup/),
                                monitoring checks (monitoring/), load generators (loadtest/)
  kapdh-mobile/                 Flutter 3.47 app (Android/iOS). Depends on the generated Dart SDK by path.
```

ADR-001: PRD 7.2 wants Flutter in a separate repo. During the build we keep one repo so contracts, SDK and app
change together; at release `git subtree split -P kapdh-mobile` produces the standalone repo, and the SDK is
published as a tagged git dependency (`contracts-vX.Y.Z`).

Toolchain on the build machine (Windows 11, Git Bash):

- Node 24.19 locally; CI and the container images use Node 24.21.0 (pinned in `.github/actions/setup-platform` and
  `kapdh-platform/infra/Dockerfile.*`). pnpm 10.28 (pinned by `packageManager`), turbo 2.
- Flutter 3.47.2 / Dart 3.13.2 at `C:\flutter\flutter\bin`. In bash: `export PATH="/c/flutter/flutter/bin:$PATH"`,
  then call `flutter.bat` / `dart.bat`.
- No Docker, no Java, no Python, no local Redis. Real PostgreSQL 17.6 is available through the `embedded-postgres`
  npm package (used by the concurrency test lane, §9.2). Redis-dependent code must have an in-memory implementation.
- Verification commands (run from `kapdh-platform/`): `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm format:check`, `pnpm contracts:lint`, `pnpm test:pg` (real Postgres lane), `pnpm test:live` (admin client
  against the merged API, §9.3). Mobile (from `kapdh-mobile/`): `flutter.bat analyze`, `flutter.bat test`.

## 2. Global rules (non-negotiable, from PRD 7.3 plus build decisions)

1. Business rules live on the server (API services + DB constraints). Clients only render and pre-validate.
2. Never collect, store, log or export NIK / Nomor KTP. No field named nik/ktp anywhere.
3. Never log or audit: passwords, password hashes, OTP codes/HMACs, refresh/reauth/invite tokens, TOTP secrets,
   backup codes, chat bodies, payment-proof content, bank account numbers entered for refunds, push tokens.
4. No Supabase, Vercel, Firebase Auth/Firestore or any BaaS. Firebase is used ONLY for FCM push.
5. Money: PostgreSQL `numeric(14,2)`; JSON `Money` decimal string `"60000.00"`; never JS/Dart floating point
   arithmetic on money. Display as `Rp60.000`.
6. Time: inject the Clock (`this.clock.now()`); never `new Date()` for business logic. Store `timestamptz` UTC.
   Display in Asia/Jakarta (`… WIB`) unless an event sets its own timezone. Set time-sensitive columns explicitly
   from the clock (DB `now()` defaults are only a fallback).
7. IDs: UUID v7 generated in the application (`import { v7 as uuidv7 } from "uuid"`). Never use DB `uuidv7()`.
8. JSON is snake_case everywhere. TS identifiers camelCase, Dart camelCase, SQL snake_case.
9. User-facing strings and code comments are Bahasa Indonesia; comments cite PRD IDs (`AC F04-3`, `N-14`, `D5`).
   Identifiers are English.
10. Status is never shown by colour alone (label + icon/colour).
11. Every state transition that matters is atomic: conditional `UPDATE … WHERE <expected state> RETURNING` or
    `SELECT … FOR UPDATE` inside one transaction; never read-then-write without a lock or predicate.
12. Critical changes write audit in the same transaction (AC F17-1); notifications go through the outbox in the same
    transaction (AC F04-1).
13. Do not change `paid` to anything else; corrections are `payment_adjustments`.
14. Do not disable MFA, do not weaken production guards, do not add fixture data to production seeds.
15. Accessibility (N-11): semantic labels, keyboard operable admin, 44–48 px targets, focus visible.

## 3. Domain model summary (what the code must enforce)

### 3.1 Account status vs effective status (PRD 2.2, 4.2)

`users.status` ∈ `pending_otp | active | disabled | deletion_pending | deleted` (authentication layer).
`effective_status` is computed per request from canonical data (never stored as truth):

```
pending_otp            → account not verified (only OTP/legal/help)
disabled|deletion_pending|deleted → no regular API (deletion-status challenge only)
alumni.suspended_at != null       → suspended   (beats any period)
alumni.expires_at == null         → unverified  (registration not paid yet)
now >= expires_at                 → expired
expires_at - now <= 30 days       → expiring
else                              → verified
```

Access levels used by the API (`@MemberAccess(...)`, §4.3):

| Level         | Allowed effective_status                    | Typical endpoints                                                       |
| ------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `any`         | unverified, verified, expiring, expired, suspended | /me, own history, account settings, legal, notifications inbox, deletion |
| `nonsuspended`| unverified, verified, expiring, expired     | payments (registration for unverified, renewal for expiring/expired), own card, profile edit, own tickets |
| `active`      | verified, expiring                          | event reservation, directory, chat send/join, likes, reports of others, blocks |

Rejections: suspended → `403 ACCOUNT_SUSPENDED`; not active → `403 MEMBERSHIP_REQUIRED`.
Special cases: paid tickets stay viewable/usable for check-in by expired members (not suspended/disabled, event not
cancelled). Chat history read stays available to room members who are expired? No — PRD 2.2 denies chat for expired;
history read is allowed only for `active`. Suspended members see the restricted portal only.

### 3.2 Membership numbers, periods, KTA

- Member number `AA.SS.JK.N` (PRD 3.5): computed server-side at OTP verification from stored registration data; N
  from sequence `app.membership_no_seq`; never from client. Admin correction recomputes the prefix, keeps N, audits
  old/new, reissues QR (AC F05-6). Pure functions already exist in `apps/api/src/membership/member-number.ts`.
- Period: registration starts at `approved_at`, renewal at `max(old expires_at, approved_at)`; +12 calendar months
  in Asia/Jakarta with end-of-month clamp (`period.ts`). One membership_event per paid payment (unique).
- KTA QR token: JWT HS256 signed with `QR_SIGNING_KEYS` (first key signs, all keys verify, `kid` header), claims
  `iss=kapdh-api`, `aud=kapdh-kta`, `sub=<alumni user_id>`, `seq=<N>`, `iat`, `exp=min(iat+7d, expires_at)`.
  QR content = `${PUBLIC_WEB_URL}/kta/${member_number}#t=${token}`. Public verify checks signature, iss/aud/exp,
  binding (`sub` and `seq` match the account AND the requested number equals the account's CURRENT number, so a QR
  issued before a number correction is "perlu diperbarui"; `qrBindingMatches`) and the **current** DB status (AC F06-*).
- Ticket QR: opaque random 128-bit code stored in `tickets.qr_code` (unique); verified by DB lookup at check-in.

### 3.3 Payments (PRD 3.3, 3.4, 4.3)

- Types: `registration`, `renewal`, `ticket`. Status: `pending → paid | rejected | cancelled`; `rejected → pending`
  only for registration/renewal (same payment, new proof version). Ticket rejection is final.
- Amount is computed by the server from `app_settings.fees` (registration = register + card fee; renewal = renewal
  fee) and snapshotted with the method (`lines_snapshot`, `method_snapshot`, `settings_version`).
- Proof upload increments `proof_version`; decision requires `expected_proof_version` and `expected_version`; one
  decision wins (row lock), loser gets `409 PAYMENT_STATE_CONFLICT` / `PROOF_VERSION_CONFLICT` with `current`.
- Approval runs in ONE transaction: payment → paid, payment_event, type handler (membership period / ticket paid),
  audit, notification + outbox.
- Conflict of interest: an admin cannot decide a payment whose owner is the admin's linked alumni account
  (`admins.linked_alumni_user_id`).
- Type handlers (registry, §4.6) decouple payments from membership and events.

### 3.4 Events and tickets (PRD 3.9, 4.4)

- Event status `draft | open | closed | done | cancelled`; ticket status
  `awaiting_payment | awaiting_review | paid | expired | cancelled`; one active ticket per (user, event); 1 seat.
- `seats_available = seats_total - held_quantity - paid_quantity`, counters maintained in the same transaction
  with CHECK `0 <= held+paid <= seats_total`; reservation locks the event row.
- Hold: 24 h or until `registration_closes_at`, whichever first; proof before the hold → `awaiting_review` keeps the
  seat. Free event → ticket `paid` immediately, no payment row.
- Check-in window: 2 h before `starts_at` until `ends_at` unless the event overrides; scan once
  (`checked_in_at IS NULL AND status='paid'`).
- Cancellation/refund rules D6 (PRD 3.9 table): refunds are `payment_adjustments` processed manually.

### 3.5 Community (PRD 3.10–3.12)

- Directory: only verified/expiring, not suspended, `show_in_directory=true`; hidden fields are omitted from the
  payload (not masked in UI). Paging default 30, max 100.
- Chat: rooms direct (canonical `direct_key = min(a,b):max(a,b)`) or group (≤100 members, invite must be accepted,
  only group admins invite, new members see history from join). Messages ≤4000 chars, `client_message_id` unique per
  sender, keyset `(created_at,id)`, read cursor monotonic. Messages are sent over HTTP (ack after commit) and
  delivered over Socket.IO.
- Blocks are bidirectional for direct send and group invites. Reports keep minimized evidence. Moderation only in web
  admin.

## 4. Backend (apps/api)

### 4.1 Layout

```
apps/api/src/
  main.ts, bootstrap.ts, app.module.ts           createApp(deps) factory (tests + prod), AppModule.forRoot(deps)
  worker.ts                                       export used by apps/worker: createWorkerContext(deps)
  core/                                           @Global CoreModule — built in Foundation, used by all modules
    tokens.ts  context/  logging/  errors/  http/  guards/  validation/  pagination/  concurrency/
    idempotency/  identity/  audit/  outbox/  settings/  rate-limit/  files/  qr/  membership/  payments-kernel/
    notifications-kernel/  realtime/  jobs/  policy/  db/
  modules/
    auth/            F-01, F-02 (alumni), sessions, password recovery/change, reauth, email correction
    admin-auth/      F-02 (admin), invitation acceptance, TOTP enrollment, backup codes
    membership/      /me, profile, card, membership periods, masters read, public KTA verify, expiry reminders
    payments/        F-03, F-04: methods, fee quote, member payments, proof, admin queue/decision, adjustments, fees settings
    files/           /files upload + signed access (thin controller over core/files)
    content/         F-08: home, posts, likes, banners, pages, categories (member + admin + public pages), announce job
    events/          F-09: events, reservations, tickets, ticket payment handler, check-in, cancellation, reminders, expiry job
    network/         F-10: directory, member profiles, masters admin CRUD
    chat/            F-11: rooms, members, invitations, messages, reactions, read, Socket.IO gateway
    moderation/      F-12: blocks, reports (member) + admin reports/resolve
    notifications/   F-13: inbox, preferences, devices, delivery processor, admin deliveries
    account/         F-14: in-app + web deletion, deletion job, ledger
    admin/           F-15/F-16/F-17: dashboard, members admin, admins & permissions, audit search/export, app settings
    public/          /public/config, /health (KTA verify & pages are served by membership/content)
```

Every module is a Nest `@Module` registered in `AppModule`. Foundation pre-creates all module folders with an empty
module class so later agents never edit `app.module.ts`. Job-owning modules (membership, payments, files, content,
events, notifications, account, admin) also have `modules/<m>/<m>-jobs.module.ts`: job processors, outbox topic
handlers, payment type handlers and the domain services they need, with NO controllers and NO API-only providers
(`API_ONLY_PROVIDERS` in core.module.ts: TokenService, SessionIssuer, PasswordVerifier, QrTokenService, guards,
gateway). The domain module imports its jobs module; the worker loads only the jobs modules (`WORKER_MODULES`).

### 4.2 Core services (contract between modules)

All are exported by the global `CoreModule`. Names are binding; exact signatures are in `core/**/index.ts`.

| Service / helper                 | Responsibility                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DB`, `ENV`, `CLOCK`, `MAILER`, `STORAGE`, `PUSH`, `REDIS?` tokens | injected adapters (AppDeps). Tests pass fakes. |
| `ctx()` request context (AsyncLocalStorage) | `requestId`, `actor` {kind alumni/admin/system/anonymous, userId, adminId, adminRole}, `ip`, `appVersion`, `platform`. |
| `TxRunner` / `withTx(fn)` + `afterCommit(fn)` | run a transaction; queue side effects (socket emits) until commit. The injected `DB` is commit-aware (`commitAwareDb`): `this.db.transaction(fn)` also runs afterCommit callbacks only on commit. Savepoints (`tx.transaction`) are not commit-aware and core kernels reject them. |
| `AppException`, `isUniqueViolation(e, constraint?)`, `isFkViolation` | domain errors, driver-agnostic DB error inspection (unwrap `DrizzleQueryError.cause`). |
| `validate(schema, body)`, `validateQuery(schema, query)`, `UuidParam` pipe | zod 4 validation → `400 VALIDATION_ERROR` with `field_errors`. |
| `encodeCursor/decodeCursor`, `pageOf(...)` | opaque base64url keyset cursors; `{items, next_cursor}` / admin `{items, next_cursor, total}`. |
| `parseIfMatch`, `assertVersion(row, expected)` | optimistic concurrency → `409 VERSION_CONFLICT` with `current`. |
| `@Idempotent()` interceptor + `IdempotencyService` | `Idempotency-Key` replay/conflict (scope = actor user id or `anon`), 24 h retention. |
| `AuditService.write(tx, entry)` + sanitizer | append-only audit with actor/request from ctx. |
| `OutboxService.publish(tx, {topic, dedupKey, payload})` | durable events consumed by the worker. |
| `NotificationService.notify(tx, {...})` | inbox row (dedup) + outbox `notification.created`. |
| `SettingsService` | typed `app_settings` (§5.4) with cache and versioned audited updates. |
| `RateLimitService.consume(key, limit, windowMs)`, `reserve`/`reserveOrThrow` | async; memory store (dev/test) or Redis store (prod). Failure limits that guard a secret check (password, TOTP, OTP) reserve a slot atomically BEFORE the check and `release()` it on success; never peek → check → hit. |
| `TokenService`, `SessionIssuer`, `PasswordVerifier`, admin refresh cookie (`core/identity`) | API runtime only. JWT access / MFA / reauth (bound to the session FAMILY) / one-time OTP-derived tokens; session issuance (refresh rotation keeps `family_id`); email+password check with per-email and per-IP failure reservation (PRD 2.5, D1). Shared by auth and admin-auth. |
| `FilesService` + `StorageDriver` | upload validation (N-10), EXIF strip/re-encode (sharp), quota, attach, signed access ≤10 min, temp cleanup. |
| `QrTokenService` | sign/verify KTA tokens with key rotation. |
| `MembershipKernel` | effective status/access, number allocation, `applyPaidPayment`, suspend/unsuspend, identity correction. |
| `PaymentHandlerRegistry` | per-type hooks (§4.6). Membership handler registered by core (pre-lock hook: owner users → alumni). |
| `RealtimeService` | `emitToUser`, `emitToRoom`, `disconnectUser`, `revokeRoomSubscription` (after commit). |
| `JobRegistry` | modules register scheduled jobs and outbox topic handlers (§4.8). |
| `BlockPolicy` | `isBlockedEitherWay(a, b, tx?)`. |
| Guards/decorators | §4.3. |
| Logger | pino (Fastify) JSON, `LOG_LEVEL`, request/job id binding, redaction list. |

### 4.3 Guards and decorators

`AuthGuard` is a global `APP_GUARD` and **denies by default**. Every handler declares exactly one of:

- `@Public()` — no authentication (public, auth bootstrap endpoints).
- `@Audience("mobile" | "admin" | "any")` — authenticated session of that audience.

Additional decorators (evaluated after authentication, server-side, every request):

- `@MemberAccess("any" | "nonsuspended" | "active")` — mobile only; computes effective status (§3.1).
- `@RequirePermission(...perms)` — admin only; all listed permissions required; evaluated from DB each request
  (AC F15-1, F16-3). `super_admin` has all permissions.
- `@RequireAnyPermission(...perms)` — admin only; at least ONE listed permission (contract `x-kapdh-access.permissions_any`),
  evaluated from DB each request; `super_admin` always passes.
- `@RequireRole("super_admin")` — admin only; Super Admin role from DB each request (contract `x-kapdh-access.role`).
- `@RequireReauth()` — needs header `X-Reauth-Token` (JWT aud `kapdh-reauth`, `sid` = session FAMILY id
  `AuthContext.familyId`, so a refresh rotation does not cancel it; ≤10 min; admin sessions need level 2).
  Used ONLY for credential actions (ADR-025, product-owner decision 2026-10-15): resend admin invitation
  (`POST /admin/admins/{adminId}/invitation`), admin recovery (`.../recovery`), regenerate own backup codes
  (`POST /admin/auth/backup-codes`), member password reset (`POST /admin/members/{userId}/password-reset`) and member
  account deletion (`POST /me/deletion`). Settings, payment-method and admin create/update/delete operations rely on
  the MFA session, permissions, `If-Match`/`Idempotency-Key` and audit instead.
- `@ConditionalReauth()` — conditional step-up for an operation where only part of the body is a credential action:
  only `PATCH /admin/admins/{adminId}` (adminUpdateAdmin), where a changed login `email` redirects the password +
  TOTP setup link (including a recovery invitation). The guard verifies an `X-Reauth-Token` when sent and sets
  `AuthContext.reauthenticated` without rejecting; `AdminsService.update` throws 403 `REAUTH_REQUIRED` for an
  email change without a valid token. Name/role/permission/status changes stay free. Contract: optional parameter
  `ReauthTokenConditional` (no `x-kapdh-access.reauth`), kept equal by `core/contract-parity.e2e.test.ts`.
  A new operation gets `@RequireReauth()` (and contract `x-kapdh-access.reauth: true` + `ReauthToken`) only if it
  creates, resets or issues a login factor (or redirects where its setup link goes) or deletes the member's own
  account; when only some fields of an operation do that, use `@ConditionalReauth()`. This deliberately deviates from
  the PRD v3.5 text of AC F15-3 and AC F16-1 (PRD 2.3 table); see ADR-025.
- `@Idempotent()` — honours `Idempotency-Key`.
- `@CurrentAuth()` param decorator → `AuthContext`.

Global request hooks (before guards): maintenance mode rejects mutating methods with `503 MAINTENANCE` except
`/auth/refresh`, `/auth/logout*`, `DELETE /auth/sessions/{id}`, `/admin/**`, `/public/**` reads (GET, plus
`POST /public/kta/verify`), and — only when the bearer is a valid admin-audience access token — `POST /auth/reauth`
(so admin credential actions such as admin recovery, backup codes and member password reset keep working during
maintenance; switching maintenance off needs only `If-Match` since ADR-025) and `POST /files` (admin work uploads:
recorded-payment proof, refund evidence); app-version gate rejects mutations from
`X-App-Platform: android|ios` with `X-App-Version` below `min_app_version` → `426 UPGRADE_REQUIRED`.

Fastify `trustProxy` comes from env `TRUST_PROXY_HOPS` (default 1 in prod, 0 in dev/test).

### 4.4 Error codes (final enum `ErrorCode`)

PRD minimum + additions: `VALIDATION_ERROR, UNAUTHENTICATED, MFA_REQUIRED, REAUTH_REQUIRED, FORBIDDEN,
MEMBERSHIP_REQUIRED, ACCOUNT_SUSPENDED, OTP_EXPIRED, RATE_LIMITED, FILE_INVALID, PAYMENT_STATE_CONFLICT,
PROOF_VERSION_CONFLICT, VERSION_CONFLICT, EVENT_SOLD_OUT, RESERVATION_EXPIRED, TICKET_ALREADY_CHECKED_IN,
IDEMPOTENCY_CONFLICT, NOT_FOUND, UPGRADE_REQUIRED, MAINTENANCE, INTERNAL_ERROR`.
Each has an entry in `packages/shared/src/errors.ts` (`ERROR_UI`) and the generated Dart catalog.
Error body: `{code, message, request_id, field_errors?, retry_after_seconds?, current?}`.

### 4.5 Permissions (final enum `Permission`)

`payments.read, payments.decide, members.read, members.manage, content.manage, master.manage, events.manage,
events.checkin, moderation.read, moderation.resolve, audit.read, audit.export, settings.manage, admins.manage,
notifications.manage`. Roles: `super_admin` (all, plus admin management with an MFA session; reauth only for
credential actions, ADR-025) and `admin` (assigned permissions only).

### 4.6 Payment type handlers

```ts
interface PaymentTypeHandler {
  type: "registration" | "renewal" | "ticket";
  /** Called by payments BEFORE locking the payment row (global lock order users → alumni → events → tickets →
   *  payments, C3/C5). Fields are read without a lock; re-check them after the payment row is locked. */
  lockRelated?(tx: Tx, payment: { id: string; ticketId: string | null; userId: string | null }): Promise<void>;
  /** Inside the proof-submission tx; may throw (e.g. RESERVATION_EXPIRED). */
  onProofSubmitted?(tx: Tx, payment: PaymentRow): Promise<void>;
  /** Inside the approval tx. Must be idempotent per payment. May report a D6 refund obligation
   *  ({refund: {amount, dueAt, reason}}) that payments records in the same tx. */
  onApproved(tx: Tx, payment: PaymentRow, approvedAt: Date): Promise<void | PaymentApprovalOutcome>;
  onRejected?(tx: Tx, payment: PaymentRow): Promise<void>;
  onCancelled?(tx: Tx, payment: PaymentRow): Promise<void>;
}
```

`registration`/`renewal` handlers are in core: `lockRelated` locks the owner's users row then alumni row
(`MembershipKernel.lockPaymentOwner`); `onApproved` = `MembershipKernel.applyPaidPayment` (idempotent; deleted owner →
`owner_deleted`, paid without membership effect; writes NO notification, because the payments module writes the single
`payment` decision notification). The `ticket` handler is registered by the events module (`onModuleInit`, in its
jobs module). The payments module never writes `tickets` or `alumni` directly.

### 4.7 Notifications, outbox topics, deep links

Categories: `payment, membership, event, news, chat, security, account`. Push preferences exist for
payment/membership/event/news/chat; email preferences for payment/membership/event; `security` and `account` are
mandatory (cannot be disabled). In-app inbox is always written.

Deep links are app routes (§8.4) carried in `notifications.data.route` (e.g. `/payments/<id>`); external form
`kapdh://app/<route>`. Lock-screen push payloads never contain chat bodies, proof data or contacts.

Outbox topics (catalog in `core/outbox/topics.ts`): `notification.created`, `account.deletion.requested`,
`audit.export.requested`, `event.cancelled`, `admin.security_notice` (email to admin), `member.password_reset_initiated`.
OTP emails are sent synchronously by the API (time-critical, user can resend) — ADR-004.

### 4.8 Jobs

Job processors live in their module's jobs module (`modules/<m>/<m>-jobs.module.ts`, testable with PGlite) and
register with `JobRegistry`; `apps/worker` runs them through `@kapdh/api/worker` (`createWorkerDeps(env)`,
`createWorkerContext(deps)`).

| Job                                  | Owner module   | Trigger                         |
| ------------------------------------ | -------------- | ------------------------------- |
| outbox dispatch                      | worker runtime | poll every 2 s, `FOR UPDATE SKIP LOCKED` |
| `notifications.deliver`              | notifications  | topic `notification.created` (email + push per prefs, FCM error classes) |
| `notifications.retry`                | notifications  | every 1 min (due deliveries)    |
| `reservations.expire`                | events         | every 1 min                     |
| `events.lifecycle` (close/done)      | events         | every 5 min                     |
| `events.reminders` (H-3, H-1)        | events         | every 15 min, dedup key         |
| `events.cancelled.fanout`            | events         | topic `event.cancelled`         |
| `membership.expiry-reminders` (30 d) | membership     | hourly, one per period          |
| `content.announce` (scheduled posts) | content        | every 1 min, once per post      |
| `files.cleanup-temp` (>24 h)         | core/files     | hourly                          |
| `maintenance.cleanup` (otp, idempotency, sessions, exports) | core/admin | daily |
| `account.deletion`                   | account        | topic + retry sweep every 10 min |
| `audit.export`                       | admin          | topic `audit.export.requested`  |

### 4.9 Realtime (Socket.IO)

Namespace `/realtime`, transport websocket, auth `{token: <access JWT>}` in handshake; the gateway re-validates the
session like the HTTP guard (re-validation is per session FAMILY, so refresh rotation never drops a socket) and
joins `user:<id>`, `session:<familyId>` and `room:<id>` for joined rooms (active members only; removal at
`expires_at`, on any MEMBERSHIP_REQUIRED/ACCOUNT_SUSPENDED rejection, and re-join after renewal/unsuspend). Server events use the envelope
`{v: 1, event_id, type, entity_id, ts, payload}`; types: `message.created, message.deleted, reaction.updated,
read.updated, room.updated, room.member_changed, typing, presence, notification.created, session.revoked`.
Client emits only `typing {room_id}` and `presence.ping`. Revocation (logout-all, suspend, expiry, leave, permission
loss) disconnects or unsubscribes (AC F02-6, F11-6, F16-3). Redis adapter when `REDIS_URL` is set. Schemas:
`packages/contracts/events/*.schema.json`.

### 4.10 API conventions (imitate existing code)

- Controllers: `@Controller("segment")`, explicit `@HttpCode`, `@Body() body: unknown` + `validate(z.object({…}))`,
  return plain snake_case objects typed `components["schemas"]["X"]` from `@kapdh/contracts`.
- Services: transactions via the injected `this.db.transaction` (commit-aware, always a NEW transaction), `TxRunner.run`
  or `withTx(db, fn)` (joins an outer withTx); never pass a savepoint (`tx.transaction`) to core kernels. Conditional
  updates with `.returning()` checks; audit + outbox in tx.
- Raw SQL results: use `rows(result)` helper (PGlite `{rows}` vs postgres-js array).
- Lists: `cursor`, `limit` (default 30, max 100), filters as query params; admin lists add `total`, `sort`.
- Versioned updates: `If-Match: <version>` header; responses carry `version` (string).

## 5. Database (packages/database)

### 5.1 Conventions

Schema `app`; `id()` uuid PK without default; `createdAt()/updatedAt()`; money numeric(14,2) + CHECK >= 0;
statuses as `app.enum` or CHECK; FKs to users from finance/audit → `ON DELETE SET NULL`; identity children →
`CASCADE`; masters/events referenced → `RESTRICT`. Index names `<table>_<cols>_idx`, unique `<table>_<cols>_key`,
checks `<table>_<what>_chk`.

### 5.2 Migrations

No production database exists, so the schema is regenerated as ONE initial migration `0000_init.sql`
(drizzle-kit generate) plus journaled custom migrations for functions/triggers (`drizzle-kit generate --custom`).
After Foundation, later changes are additive migrations. SQL must run on PostgreSQL 17 (production) and PGlite
(PG 18 in tests): no `uuidv7()`, no virtual generated columns, no PG18-only syntax. The PGlite harness and the
production migrator both apply journaled migrations in order inside a transaction.

### 5.3 Tables (37 PRD tables + 2 justified extras)

Identity: `users`, `otp_codes`, `sessions`, `mfa_totp`, `admins`, `admin_permissions`(extra, normalized permission set).
Membership: `alumni`, `master_professions`, `master_skills`, `alumni_professions` (≤1 per alumni), `alumni_skills`
(≤10), `membership_events`, sequence `membership_no_seq`.
Finance: `payments`, `payment_events` (append-only), `payment_methods`, `payment_adjustments`, `app_settings`.
Content: `categories`(extra, kind post|event — guideline "Manajemen Kategori"), `posts`, `post_likes`, `banners`, `pages`.
Events: `events`, `tickets`.
Community: `blocks`, `rooms`, `room_members`, `messages`, `message_reactions`, `reports`.
Notifications: `notifications`, `notification_preferences`, `device_tokens`, `notification_deliveries`.
Platform: `files`, `audit_logs` (append-only), `outbox_events`, `idempotency_keys`, `account_deletions`.

`fee_settings` is removed: fees live in `app_settings` key `fees` (versioned); payments store `settings_version`.

### 5.4 app_settings keys (typed with zod in `core/settings/keys.ts`)

| Key               | Value                                                                                       | Initial (seed)            |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `fees`            | `{registration_fee, card_fee, renewal_fee}` Money strings                                   | 50000.00 / 10000.00 / 10000.00 (D4) |
| `membership`      | `{period_months: 12, expiring_days: 30, renewal_window_days: 30}`                           | fixed by PRD (read-only)  |
| `events`          | `{hold_hours: 24, checkin_before_hours: 2, self_cancel_days: 3, review_escalation_business_days: 2}` | D5/D6 |
| `chat`            | `{max_text_chars: 4000, max_group_members: 100}`                                            | v3.2                      |
| `min_app_version` | `{android: "1.0.0", ios: "1.0.0"}`                                                          |                           |
| `maintenance`     | `{active: false, message: null, until: null}`                                               |                           |
| `store_links`     | `{android: url|null, ios: url|null}`                                                        |                           |
| `support`         | `{email: "bantuan@kapdh.or.id", whatsapp: null}`                                            | 8.3                       |
| `legal`           | `{privacy_version, terms_version, community_version}` (mirrors published `pages`)           |                           |
| `payment_instructions` | `{dues_hidden_platforms: Array<"android" or "ios">}` (D13 iOS fallback; tickets never hidden) | `[]` |

Production seed (`packages/database/seeds/reference.ts`) inserts masters, settings and legal page shells and refuses
to run fixture data; dev seed (`seeds/dev.ts`) adds clearly marked synthetic fixtures and refuses NODE_ENV=production.

## 6. Contracts (packages/contracts)

- Source: `openapi/root.yaml` (info, servers, security, shared components: Error, ErrorCode, Money, Permission,
  EffectiveStatus, Gender, pagination parameters, IfMatch, IdempotencyKey, ReauthToken, standard responses) +
  `openapi/domains/<domain>.yaml` (`tags`, `paths`, `components` owned by that domain).
- `pnpm --filter @kapdh/contracts bundle` assembles `dist/openapi.yaml` (fails on duplicate path/operationId/tag/
  component). Lint runs on the bundle with strict rules (named body schemas, snake_case properties).
- Generated, never committed: `src/generated/api.ts` (openapi-typescript) and the Dart SDK
  `dart/kapdh_api/lib/src/**` (custom Node generator `scripts/gen-dart.mjs`; hand-written `pubspec.yaml` and
  `lib/kapdh_api.dart` barrel are committed). Run `pnpm contracts:gen` after pulling.
- Domain files: `auth, admin-auth, account, me, public, admin-members, admin-masters, payments, admin-payments,
  files, admin-settings, content, admin-content, events, admin-events, network, chat, moderation, admin-moderation,
  notifications, admin-notifications, admin-dashboard, admin-admins, admin-audit`.
- Schema names are domain-prefixed where ambiguous (`EventSummary`, `ChatMessage`, `AdminMemberDetail`).
- Pagination schema name `<Thing>Page`; enums are strings with lower_snake values; nullable via `type: [X, "null"]`.
- Contract tests: `expectOperation(method, path, res)` validates every response against the declared status schema;
  a coverage test ensures every registered Fastify route exists in the contract.

## 7. Web admin (apps/admin)

- React 19, Vite, TanStack Router (code-based, one route file per area under `src/routes/`), TanStack Query,
  TanStack Table (server-side paging/filter/sort), react-hook-form + zod, Tailwind 4 with `@kapdh/design-tokens`.
  shadcn-style components are written in-repo under `src/components/ui/` (no CLI).
- Design follows guideline p10–17 and `screen_8_admin_payments.html`: dark green sidebar (`surface-dark`), logo,
  gold pending-count pill, cream background, white cards, dark-green pill tabs, green edit / red delete row icons.
- Areas and routes (all pre-registered in Foundation):
  `/login, /login/mfa, /login/enroll, /invite` (token in the fragment: `/invite#t=<token>`) · `/` Dashboard ·
  `/payments` (tabs: Verifikasi | Metode | Biaya | Penyesuaian) · `/members`, `/members/$userId`, `/members/masters` · `/content` (tabs: Berita | Banner |
  Halaman | Kategori), `/content/posts/new`, `/content/posts/$postId` · `/events`, `/events/new`, `/events/$eventId`,
  `/events/checkin` · `/moderation`, `/moderation/$reportId` · `/admins`, `/admins/$adminId` · `/audit` ·
  `/notifications` · `/settings` · `/account`.
- Every page: permission-gated route + API checks, loading/empty/error/forbidden states, version-conflict reload,
  confirmation dialogs for reject/suspend/cancel/delete/permission changes (PRD 4.5), reauth dialog for credential
  actions only (resend invitation, admin login-email correction, admin recovery, backup codes, member password
  reset; ADR-025), keyboard +
  screen-reader operable (N-11).
- Mock mode (`pnpm --filter @kapdh/admin dev:mock`, and tests) uses per-domain handlers in `src/api/mocks/<area>.ts`;
  mock evidence never counts as AC proof. Every mock route is exercised by `src/api/mocks/contract-conformance.test.ts`
  and each response body is validated against the bundled contract (Ajv, same rules as `expectOperation`), with the
  contract's `x-kapdh-access` permissions and reauth enforced; a page that starts using a new admin operation adds
  its mock first (the test fails on an admin operation without a mock unless `KNOWN_WITHOUT_MOCK` lists it).

## 8. Flutter app (kapdh-mobile)

### 8.1 Stack

Riverpod 3 (manual providers, no codegen), go_router 16, dio 5 + generated `kapdh_api`, flutter_secure_storage,
qr_flutter, socket_io_client, firebase_core + firebase_messaging (push only), flutter_local_notifications,
image_picker, file_picker, cached_network_image, connectivity_plus, package_info_plus, url_launcher,
shared_preferences, intl + timezone, flutter_widget_from_html_core, uuid, pub_semver. Poppins bundled as assets
(no runtime font fetching). Dev: mocktail, http_mock_adapter.

### 8.2 Structure

```
lib/
  main.dart, bootstrap.dart
  app/            router.dart (all routes), redirect.dart (PRD 2.2 matrix, pure + tested), shell (bottom nav), theme/
  design/         design-system widgets (KapdhButton 52px gradient, KapdhTextField label-above, OtpBoxes, KtaCard,
                  StatusHero, SummaryCard, Timeline, OfflineBanner, UploadTile, MethodRadioCard, InfoBox,
                  AmountCopyBox, EmptyState, ErrorState, LoadingSkeleton, StatusBadge, SectionHeader, AppScaffold)
  core/           api (dio, refresh coordinator, error catalog, idempotency store), session, app_gate (config,
                  min version, maintenance), cache (KTA offline), push, realtime (socket), format (Rp, WIB), storage
  features/<f>/   screens, widgets, controllers, repositories per feature:
                  auth, onboarding, payments, kta, home, news, events, tickets, network, chat, notifications,
                  account, legal, status (restricted, deletion)
```

### 8.3 Behaviour rules

- One refresh coordinator shared by HTTP, socket and background push; tokens cleared only on `UNAUTHENTICATED`
  from refresh; network errors never log the user out.
- App gate on splash: `/public/config` → update-required / maintenance screens; every request sends
  `X-App-Version` and `X-App-Platform`.
- Offline KTA cache (AC F05-2..4): store last card + `synced_at` + user id; show only if ≤7 days old and before
  `expires_at`, labelled "Offline"; cleared on logout/account change.
- Idempotency keys persisted until the outcome is known (PRD 4.3).
- Error codes map through the generated catalog to uniform UI actions.

### 8.4 Routes

System: `/splash, /update-required, /maintenance`. Auth: `/login, /register, /register/otp, /forgot, /forgot/otp,
/forgot/reset`. Onboarding & payments: `/onboarding/fees, /payments/new/:type, /payments/:paymentId, /payments`.
Shell tabs: `/home` (Beranda), `/events` (Event), `/kta` (KTA), `/network` (Jejaring: tabs Alumni | Pesan | Grup),
`/account` (Akun). Details: `/news, /news/:slug, /events/:eventId, /tickets, /tickets/:ticketId, /renewal,
/network/members/:userId, /chat/:roomId, /chat/:roomId/info, /chat/new-group, /chat/invitations, /notifications,
/account/profile, /account/privacy, /account/notifications, /account/sessions, /account/password,
/account/blocked, /account/reports, /account/delete, /legal/:slug`. Status portals: `/restricted, /deletion-status`.

## 9. Testing

### 9.1 Default lane (PGlite)

`apps/api/test/<module>/*.e2e.test.ts` with `createTestApp()` (PGlite + journaled migrations + TestClock +
MemoryMailer + FakePush + MemoryStorage). Shared factories in `test/support/factories.ts` (createAlumni({status}),
createAdmin({permissions}), signInAlumni, signInAdmin, createEvent, …). Test names in Indonesian, prefixed with AC
IDs. Every endpoint: happy path, validation, authz negative (wrong audience, missing permission, wrong status,
other user's object id), and contract validation via `expectOperation`.

### 9.2 Real PostgreSQL lane

`apps/api/test/pg/*.pg.test.ts`, run by `pnpm --filter @kapdh/api test:pg`, uses `embedded-postgres` (PG 17.6) with
real concurrent connections (postgres-js pool). Mandatory scenarios (PRD 9.2): last-seat race, one member double
reserve, double approval, proof replaced during decision, last Super Admin concurrent demotion, direct-room race,
duplicate registration, idempotent replay under concurrency.

### 9.3 Clients

Admin: vitest + Testing Library on mock mode per page; Flutter: unit tests for pure logic, widget tests for every
screen state, interceptor/session tests with http_mock_adapter, 200% text scale on critical flows.

Admin live lane (`pnpm test:live` from `kapdh-platform/`, or `pnpm build` then `pnpm --filter @kapdh/admin
test:live`; not part of `pnpm test`, but a step of the CI `test` job, so "CI lulus" gates it):
`apps/admin/live/api-server.mjs` boots `apps/api/dist` on a local TCP port with PGlite migrated by the production
migrator, seed dev data, two TOTP-enrolled admins and a member proof, plus a 127.0.0.1-only control port (server
clock, TOTP codes). `apps/admin/src/live/*.live.test.tsx` drives the shipped React pages and openapi-fetch client
over real HTTP (cookies, multipart uploads): login + TOTP and session restore, refresh rotation, the idle warning
whose "Tetap masuk" extends the server idle, 30-min idle revocation, concurrent payment decision, D13 "Catat iuran"
and payment deep links. Scenarios whose UI clause is only proven against mocks belong here once they touch a server
rule.

## 10. Operations (summary; details in docs/runbooks)

Coolify on one VPS (4 vCPU/8 GB/100 GB), Traefik TLS, images built in CI, single migration job with advisory lock,
daily encrypted backups (pg_dump + restic of `/data/files`) to off-VPS object storage with manifest and deletion
ledger, monthly restore drill, Uptime Kuma + GlitchTip, staging and production fully separated.

- CI/CD (ADR-024, `docs/runbooks/ci-cd.md`): `.github/workflows/ci.yml` (status "CI lulus": build, typecheck, lint,
  format, PGlite + PG17 lanes, Dart SDK, Flutter, `pnpm audit --prod`/OSV, contract breaking-change gate N-13, image
  builds + smoke + grype, Compose stack job), `deploy-staging.yml` (images once per commit `sha-<commit>`, catalog
  `infra/ci/images.json`), `release.yml` (same digest promoted to `vX.Y.Z`, approval-gated production deploy,
  `deploy-tag` rollback). Images: `infra/Dockerfile.{api,worker,web,admin}`, `api` target `release` for the release job.
- Release job + go-live gate (ADR-023, `docs/runbooks/rilis-dan-gerbang-go-live.md`): one sequence ([pre-migration
  dump] → `roles.sql` → `golive:check --preflight` → migrate as `kapdh_migrator` → `roles.sql` → `seed:reference` →
  `golive:check`), `enforce` in production (refusal stops the deploy), `report` in staging; run by the CI forced
  command `infra/ci/remote-migrate.sh` (Coolify path) or by `infra/scripts/release-job.sh` in the `kapdh-release`
  image (manual and Compose fallback, `docs/runbooks/compose-cadangan.md`). Never at replica startup.
- Backup/restore: `infra/backup/` (backup.sh, restore.sh, verify-restore.sh; ADR-018), runbooks
  `docs/runbooks/backup-restore.md` (procedure, monthly drill, RPO/RTO) and `restore-backup.md` (application order).
  Retention (D2): dump snapshots older than 30 days are forgotten, files snapshots are forgotten with their paired
  dump, then `restic prune --max-unused 0`; `RETENTION_DAYS + BUCKET_NONCURRENT_DAYS <= 30`. Restore runs as root (or
  the `FILES_OWNER` uid) so the ledger CLI in the image (uid 1000) can read the ledger copy; the CLI never needs Redis.
  After restore: API alone until readiness `deletion_ledger: ok`, then the worker.
- Deletion ledger: StorageDriver copy + head + readiness gate (ADR-014) AND a synchronous append-only off-VPS bucket
  `DELETION_LEDGER_S3_*` written before any data is deleted (ADR-019, required for the production worker).
- Monitoring: Uptime Kuma HTTP monitors + Push heartbeats from `infra/monitoring/*.sh` (disk, worker, outbox,
  providers, deletions, backup age); GlitchTip via `SENTRY_DSN` from safe error logs only (ADR-021);
  `docs/runbooks/monitoring.md`, `incident-response.md`.
- Capacity: `infra/loadtest/` (N-01, N-02, N-04) with the staging-only dataset CLI `loadtest:seed` (ADR-020; refuses
  databases without `ALTER DATABASE ... SET kapdh.environment = 'staging'`); `docs/runbooks/load-test.md`.
- Storage migration local -> S3 with `STORAGE_FALLBACK_LOCAL_ROOT` (ADR-022); `docs/runbooks/storage-migration.md`.

## 11. Agent protocol

1. Read this file, `docs/BUILD_PLAN.md`, and the PRD sections for your slice before coding.
2. Only touch the paths your task owns. Shared files (core, schema, root.yaml, app.module, routers, pubspec, lockfiles)
   are owned by Foundation/integrator; if you need a change there, make the smallest additive change and list it in
   your report under `shared_changes`.
3. Do not modify generated files by hand. Do not commit generated outputs.
4. Before finishing: run the verification commands for your area; all must pass. Report exactly what passed and
   what did not. Never claim a pass you did not observe.
5. Commit your work on your branch with a message `feat(<area>): … (F-xx, AC …)`. End commit messages with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
