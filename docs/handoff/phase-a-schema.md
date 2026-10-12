# Phase A handoff: schema

Facts recorded by the Phase A agents after build, adversarial review and fixes. Binding for later phases unless docs/ARCHITECTURE.md says otherwise.

## FIX open_issues
- The OpenAPI contract is still not aligned with the database enums (carried over from the builder): OtpChallenge.purpose has no email_change; the Permission enum has 14 values while the database has 15; FilePurpose and NotificationCategory ('account') differ; DeletionRequest.status has no 'failed'; FeeSettings is now app_settings 'fees'. New: the page contract should expose published_version and published content separately from the draft.
- Content slice: the publish endpoint must copy title/body_html into published_* and bump published_version in one conditional UPDATE. It must also write a `page.published` audit entry containing the published text, so earlier accepted versions can be shown again (F-01). The like endpoint must only INSERT ... ON CONFLICT DO NOTHING or DELETE on post_likes and never write like_count.
- Account (F-14) slice: the deletion job must run anonymization inside `BEGIN; SET LOCAL ROLE kapdh_audit_purge; UPDATE audit_logs/payment_events ...; COMMIT`. It must also append each completed entry to an external append-only deletion ledger kept with the backup manifest; account_deletions.ledger is only the job's working copy (AC F14-6).
- Trade-off: making kapdh_worker a member of kapdh_audit_purge means a compromised worker process could SET ROLE and alter audit rows. If the architect wants stricter separation, a dedicated purge login role with its own connection is the alternative; roles.sql is written so that change is easy.
- The Super Admin guard refuses possible reductions (0A000) under REPEATABLE READ or SERIALIZABLE; the application runs at READ COMMITTED. A deadlock is still possible if one transaction updates users and then admins for the same admin, while another updates admins and then users; services should update admins first (documented in the README).
- bootstrap-admin CLI (carried over): its 'Super Admin already exists' check looks only at admins.status, not users.status. It also still creates the first Super Admin with TOTP already verified, while PRD 8.2 and F-16 require a password change and TOTP enrollment before activation. Belongs to the admin-auth / core-api slice.
- N allocation rule: services must call nextval('app.membership_no_seq') and then INSERT/UPDATE that alumni row in the same session and transaction, with no other nextval in between (alumni_member_seq_source_chk). Bulk import is out of scope for R1.0 (PRD line 91).
- Carried over: PostgreSQL 18 (PGlite) reports FK RESTRICT as 23001 while PostgreSQL 17 reports 23503, so isFkViolation must accept both. The alumni_skills_limit check runs before ON CONFLICT, so replace a member's skill set with delete-then-insert. The OpenAPI and core-api typecheck of apps/api test/** is still not part of pnpm typecheck.
- Ops (Phase E): the migration job command in the production image is `node node_modules/@kapdh/database/dist/bin/migrate.js`, run as kapdh_migrator, followed by `psql -f infra/db/roles.sql`. Seeds use dist/bin/seed-reference.js. Production must be PostgreSQL 16 or later for the GRANT ... WITH INHERIT/SET syntax (PostgreSQL 17 is planned). A CI step for `pnpm test:pg` is still needed.
- The PRD 6.4 idea of DB-trigger audit is still not implemented, per ARCHITECTURE §4.2 (carried over from the builder).

## BUILD handoff
PACKAGE API (@kapdh/database, built to dist/src):

- Exports every table, enum and relation, plus:
  - constants: PERMISSIONS / Permission (15), FILE_PURPOSES / FilePurpose (8), APP_SETTING_KEYS / AppSettingKey (fees, membership, events, chat, min_app_version, maintenance, store_links, support, legal), MAX_ALUMNI_SKILLS = 10
  - helpers: app, id, tstz, createdAt, updatedAt, money, version, sqlInList
  - `schema`, the merged object for drizzle({schema})
  - createDb(url, {max?, applicationName?}) returning {db, sql}; type Database
  - runMigrations({url, migrationsFolder?, lockWaitMs?, log?}) returning {applied}; MIGRATIONS_FOLDER; MIGRATION_LOCK_KEY = 4711000517
- Seed subpaths:
  - '@kapdh/database/seeds/reference': seedReference(db, {now?, requestId?}), REFERENCE_SETTINGS, STARTER_PROFESSIONS, STARTER_SKILLS, LEGAL_PAGE_SHELLS
  - '@kapdh/database/seeds/dev': seedDev(db), DEV_IDS, assertNotProduction, ProductionSeedRefused

COMMANDS:

- `pnpm --filter @kapdh/database migrate | seed:reference | seed:dev | db:generate | db:generate:custom --name=x | db:check | test`
- `pnpm test:pg` (root), or `pnpm --filter @kapdh/api test:pg`
- Ops order: roles.sql, then migrate, then roles.sql again after every migration.

RENAMES AND NEW SEMANTICS:

- admins.active is now admins.status, an enum invited|active|disabled, default 'invited'. CHECKs:
  - active requires activated_at
  - disabled requires disabled_at
  - invite_token_hash and invite_expires_at are set together, and only while status is invited
- Other admins columns: linked_alumni_user_id (unique when not null), invited_by_admin_id, version, permissions_version.
- admin_permissions: (admin_id, permission CHECK over 15 values, granted_by_admin_id, created_at).
- users:
  - email must equal lower(btrim(email))
  - UNIQUE users_kind_email_key on (kind, email) WHERE status <> 'deleted'; always query by email + kind + status <> 'deleted'
  - password_hash stays NOT NULL (invited admins get a random initial password)
  - new column last_login_at
- otp_codes:
  - otp_purpose gains 'email_change'
  - UNIQUE otp_codes_active_key on (user_id, purpose) WHERE consumed_at IS NULL AND superseded_at IS NULL; supersede the old challenge in the same tx before inserting
- sessions:
  - new columns: platform (android|ios|web), app_version, reauthenticated_at
  - CHECKs: audience mobile|admin, mfa_level 1|2
  - replaced_by is a self-FK
- mfa_totp: new last_used_step bigint and updated_at.
- alumni:
  - profession_id removed; use alumni_professions (PK (alumni_user_id, profession_id), UNIQUE alumni_user_id)
  - new columns: bio (500 max), last_education_institution, last_education_city, social_instagram, social_x, social_facebook, social_linkedin, show_email, suspension_reason, suspended_by_admin_id
  - avatar_file_id is an FK to files; version is now int
  - alumni_member_number_chk: member_number must equal lpad(cohort,2)||'.'||SS||'.'||JK||'.'||member_seq, so correct cohort/classes/gender and member_number in ONE UPDATE
  - alumni_period_chk: starts_at and expires_at are both null or both set, with expires_at > starts_at
- membership_events:
  - kind is an enum, which now includes 'warn'
  - payment_id is an FK with UNIQUE membership_events_payment_id_key
  - new columns: actor_admin_id, reason, before/after_starts_at, before/after_expires_at, before/after_member_number (renamed from before_number/after_number)
- payments:
  - settings_version replaces fee_settings_version; it is null only for type='ticket'
  - new columns: payment_method_id, cancelled_at, cancel_reason
  - payments_ticket_chk: (type='ticket') = (ticket_id is not null)
  - partial UNIQUEs: payments_user_id_type_open_key and payments_ticket_id_key
  - payments_paid_chk: proof_version >= 1 and decided_at set
  - payments_rejected_chk: decided_at set and a non-blank rejection_reason
  - payments_cancelled_chk: cancelled_at set
  - there is NO tickets.payment_id
- payment_events:
  - kind enum gains method_changed; new proof_file_id
  - actor columns and proof_file_id deliberately have no FK, so cascades cannot update the append-only table
- payment_adjustments.refund_destination must be null unless kind='refund' AND status='pending', so purge it on complete or cancel.
- app_settings: (key PK, value jsonb object, version, updated_by_admin_id, updated_at).
- files:
  - new columns: width, height, expires_at, updated_at
  - status default is now 'pending', so FilesService must set 'ready'
  - files_private_purpose_chk: only avatar and cover/banner images may be public
- idempotency_keys: (id PK, scope text, endpoint, key text, status in_progress|completed, ...), UNIQUE idempotency_keys_scope_endpoint_key_key.
- outbox_events: new columns request_id, last_error, locked_until; status CHECK pending|dispatched|failed|dead; unique outbox_events_dedup_key_key.
- notifications: dedup_key is NOT NULL and globally unique (notifications_dedup_key_key), so include the user id in the key.
- notification_preferences rows are allowed only for push {payment, membership, event, news, chat} and email {payment, membership, event}; a missing row means enabled.
- notification_deliveries: push rows require device_token_id and email rows must leave it null; UNIQUE NULLS NOT DISTINCT on (notification_id, channel, device_token_id).
- messages:
  - messages_content_chk requires content unless deleted_at is set
  - client_message_id is required for non-system messages
  - account deletion must placeholder messages before deleting files or users
- account_deletions:
  - request_number must match ^DEL-[0-9]{4}-[0-9A-Z]{4,}$ (no second sequence)
  - one open request per user via account_deletions_user_id_open_key
  - new column next_attempt_at
- audit_logs.effective_role is one of alumni, admin, super_admin, system, anonymous.

TRIGGERS:

- Append-only violations raise 42501 with a message containing 'append-only'.
- The last-super-admin guard raises 23514 with constraint admins_last_super_admin_chk. Demote with a conditional UPDATE ... RETURNING, not SELECT ... FOR UPDATE on admin rows first, or a 40P01 deadlock is possible.
- The skills cap raises 23514 alumni_skills_limit_chk.

TEST HARNESS:

- createTestApp() returns {app, db, mailer, clock, pg}.
- New createTestDatabase() returns {pg, db}.
- The PG lane helpers in apps/api/test/pg/support.ts:
  - createPgTestDatabase(label, pool) returns {name, url, db, sql, drop}
  - createEmptyPgDatabase
  - barrier(n), withLockWaitProbe(sql, promise), pgError(e) returning {code, constraint, message}
  - insertUser, insertAdmin, insertEvent
  - inject('kapdhPg')
- Name PG lane test files test/pg/*.pg.test.ts.

DEV FIXTURES: password Kapdh#Dev2026; accounts contoh1/2/3@kapdh.test (unverified, active, payment pending).

REFERENCE SEED: masters are inserted with active=false, so pengurus must activate them. Legal pages are drafts with slugs kebijakan-privasi, ketentuan, ketentuan-komunitas, bantuan, tentang. The app_settings 'legal' versions stay null until those pages are published.

## FIX handoff
DATABASE PACKAGE (@kapdh/database) CHANGES SINCE 91d320a:

CLI ENTRY POINTS:
- Entry files are dist/bin/migrate.js, dist/bin/seed-reference.js and dist/bin/seed-dev.js. They always run when executed, including through a pnpm symlink, and exit 1 on failure.
- Package scripts are unchanged in name: `pnpm --filter @kapdh/database migrate | seed:reference | seed:dev`.
- New programmatic export: runMigrateCli(env?) returns Promise<number>.
- runSeedCli(label, run, env?) now returns Promise<number> instead of exiting the process.
- The seeds/reference and seeds/dev modules no longer run anything when imported.

MIGRATIONS (journal order):
- 0000_init
- 0001_append_only
- 0002_last_super_admin (rewritten)
- 0003_alumni_skills_limit
- 0004_identity_guards (new)
- 0005_post_like_count (new)

LAST SUPER ADMIN GUARD (0002):
- A Super Admin counts only if it can log in: admins.role='super_admin', admins.status='active' and users.status='active'.
- The guard fires on admins UPDATE OF role/status/user_id, admins DELETE, admins TRUNCATE, and users UPDATE OF status / DELETE for an active admin-kind account.
- Errors:
  - 23514 with constraint admins_last_super_admin_chk; the error's TABLE is 'admins' or 'users'.
  - 0A000 when the transaction isolation is not READ COMMITTED.
- Advisory lock key: 4711000518.
- Services may use SELECT ... FOR UPDATE on the admin row and then UPDATE (no deadlock). In one transaction, update admins before users.

NEW CONSTRAINTS AND TRIGGERS (all raise 23514 with these constraint names):
- users_kind_immutable_chk
- alumni_user_kind_chk
- admins_user_kind_chk
- admins_linked_alumni_kind_chk
- alumni_member_seq_immutable_chk
- alumni_member_seq_source_chk: member_seq must equal currval('app.membership_no_seq') in this session; nextval then INSERT/UPDATE in the same transaction
- post_likes_immutable_chk
- reports_resolution_note_chk: status resolved or dismissed needs a non-blank resolution_note
- pages_published_chk

POSTS.LIKE_COUNT:
- Maintained only by triggers; services never write it.

PAGES (new columns):
- published_title, published_body_html, published_version (int).
- title and body_html are the draft; `version` is the If-Match counter.
- published_version is the legal version referenced by users.policy_version and app_settings 'legal'.

INDEXES:
- device_tokens_user_id_idx is a full index (it replaces device_tokens_user_id_active_idx).
- payments_ticket_id_key is now a full unique index on ticket_id.
- New partial indexes, named <table>_<column>_idx, on every other foreign key that had no usable index.
- A PGlite test fails if any foreign key lacks a usable index.

AUTH:
- AuthService.issueOtp(user, purpose, replacing?) locks the users row first. Any new code that creates OTP challenges must do the same.

ROLES:
- kapdh_worker is a member of kapdh_audit_purge with INHERIT FALSE, SET TRUE.
- Anonymization pattern: `SET LOCAL ROLE kapdh_audit_purge` inside the transaction, then UPDATE audit_logs / payment_events.

PG-LANE HELPERS (apps/api/test/pg/support.ts):
- connectAs(tdb, 'kapdh_app' | 'kapdh_worker', poolSize?) returns {db, sql}: a real non-superuser login. Call sql.end() when done.
- insertAdminAccount(sql, {role, status}) returns {adminId, userId}.
- PgLaneConfig now includes rolePassword.
- To start the Nest app on real PostgreSQL, see auth-otp.pg.test.ts: createApp({env: testEnv, db: connectAs(...).db as Db, mailer, clock}).

TEST COUNTS: database package 19 tests (PGlite); API default lane 85 tests; pg lane 56 tests in 7 files.

