# KAPDH Apps — R1.0 Build Plan

This plan sequences the R1.0 build (PRD F-01..F-17, N-01..N-16) into phases that can run in parallel without
stepping on each other. Engineering rules are in `docs/ARCHITECTURE.md`.

## Phase overview

| Phase | Goal | Work items (one branch each, isolated git worktree unless noted) |
| ----- | ---- | ----------------------------------------------------------------- |
| A. Foundation-1 | Data model and contract pipeline | `schema` (all tables, triggers, migration runner, seeds, PG lane); `contracts-infra` (split OpenAPI, assemble, lint rules, TS gen, Dart SDK generator, contract test hardening, error/permission catalogs) |
| B. Foundation-2 | Shared runtime and client shells | `core-api` (CoreModule, guards, ctx, logging, idempotency, audit, outbox, settings, rate limit, files/storage, QR, membership kernel, payment handler registry, notifications kernel, realtime base, job registry, module skeletons, test factories, auth security fixes); contract authors `C1..C7` (one domain group each); `admin-foundation`; `mobile-foundation` |
| C. Build | Vertical slices against the agreed contract | API modules (auth, admin-auth, membership, payments, content, events, network, chat, moderation, notifications, account, admin); worker runtime; admin pages (5 groups); Flutter features (5 groups); public web |
| D. Hardening | Prove the ACs | security review, AC coverage audit, concurrency lane, privacy/deletion audit, fix loops |
| E. Release readiness | Operate it | infra (Dockerfiles, compose fallback, CI, backup/restore scripts), runbooks, ADRs, README, final verification |

The integrator merges each phase into `main`, regenerates contracts/SDK, runs the full verification suite, and fixes
integration breaks before the next phase starts.

## Ownership map (who may edit what)

| Path | Owner |
| ---- | ----- |
| `packages/database/**`, `apps/api/test/support/test-app.ts`, `apps/api/test/pg/**` (lane infra) | schema (A), integrator after |
| `packages/contracts/{scripts,openapi/root.yaml,redocly.yaml,package.json,dart/kapdh_api/pubspec.yaml}`, `packages/shared/**` | contracts-infra (A), integrator after |
| `packages/contracts/openapi/domains/<d>.yaml` | contract author (B), then the API module owner of `<d>` (C, additive only) |
| `apps/api/src/core/**`, `apps/api/src/app.module.ts`, `apps/api/src/bootstrap.ts`, `apps/api/test/support/**`, `packages/storage/**`, `packages/config/**` | core-api (B), integrator after |
| `apps/api/src/modules/<m>/**`, `apps/api/test/<m>/**` | API module `<m>` owner (C) |
| `apps/worker/**` | worker owner (C) |
| `apps/admin/src/{components,api/client.ts,auth,routes/__root*,router.tsx,nav.ts}` | admin-foundation (B) |
| `apps/admin/src/routes/<area>/**`, `apps/admin/src/api/mocks/<area>.ts` | admin page `<area>` owner (C) |
| `kapdh-mobile/lib/{app,design,core}/**`, `pubspec.yaml` | mobile-foundation (B) |
| `kapdh-mobile/lib/features/<f>/**`, `kapdh-mobile/test/features/<f>/**` | Flutter feature `<f>` owner (C) |
| `apps/web/**` | public-web owner (C) |
| `infra/**`, `docs/runbooks/**`, `docs/adr/**`, `.github/**` | ops owner (E) |

## Contract domain groups (Phase B authors)

| Group | Domain files |
| ----- | ------------ |
| C1 Identity | `auth.yaml`, `admin-auth.yaml`, `account.yaml` |
| C2 Membership | `me.yaml`, `public.yaml`, `admin-members.yaml`, `admin-masters.yaml` |
| C3 Finance | `payments.yaml`, `admin-payments.yaml`, `files.yaml`, `admin-settings.yaml` |
| C4 Content | `content.yaml`, `admin-content.yaml` |
| C5 Events | `events.yaml`, `admin-events.yaml` |
| C6 Community | `network.yaml`, `chat.yaml`, `moderation.yaml`, `admin-moderation.yaml`, `events/*.schema.json` (realtime) |
| C7 Admin & notifications | `notifications.yaml`, `admin-notifications.yaml`, `admin-dashboard.yaml`, `admin-admins.yaml`, `admin-audit.yaml` |

## Build slices (Phase C)

API modules: `auth` (+ password recovery, sessions, reauth, email correction), `admin-auth` (+ invitation, TOTP
enrollment, backup codes), `membership` (+ card, public verify, profile, masters read, expiry reminders),
`payments` (+ methods, fees, adjustments, admin queue), `content`, `events`, `network`, `chat` (+ gateway),
`moderation`, `notifications` (+ delivery processor), `account` (+ deletion job), `admin` (dashboard, members admin,
admins, audit + export job, settings).

Admin pages: `payments` (queue, methods, fees, adjustments), `members` (+ masters), `content` (posts, banners, pages,
categories), `events` (+ check-in scanner), `governance` (dashboard, admins, audit, moderation, notifications,
settings, account).

Flutter features: `onboarding-payments-kta` (fees, payment, proof, waiting/rejected, KTA + offline, renewal),
`home-news-events` (home, news, events, tickets), `network-chat` (directory, profiles, chat, invitations, blocks,
reports), `account-notifications` (inbox, prefs, push, profile edit, privacy, sessions, password, legal, delete
account, status portals), `auth` polish (forgot password, OTP boxes, email correction).

## Acceptance evidence

Every F-xx and AC is traced to tests in `docs/qa/traceability.md` (generated in Phase D from test names). A slice is
done only when its ACs have passing automated tests on the API (PGlite or PG lane) and its client screens have
widget/component tests for loading, empty, error, forbidden and success states.
