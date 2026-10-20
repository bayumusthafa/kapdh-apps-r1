# Phase A handoff: contracts-infra

Facts recorded in Phase A after build, adversarial review and fixes. Binding for later phases unless docs/ARCHITECTURE.md says otherwise.

## FIX open_issues
- All 10 realtime event types are listed in `x-kapdh-payload-pending` in events/envelope.schema.json. C6 must add events/<type>.schema.json for each type (or move a type to x-kapdh-payload-less) and remove it from the pending list. Until then the TS payloads are Record<string, unknown> and the Dart event classes expose the raw Map, and contracts:lint prints a warning.
- PRD-vs-design conflict resolved in favour of PRD 2.2 / AC F06-2: expired members are labelled 'KTA Kedaluwarsa' (shared MEMBERSHIP_LABEL, generated Dart membershipLabel, design tokens, and the new MemberCardStatus.expired). The integrator or product owner should confirm the exact wording. kapdh-mobile/lib/app/theme/kapdh_tokens.dart is a hand-made copy of the design-tokens output owned by mobile-foundation and still says 'KTA Tidak Aktif' for expired. mobile-foundation should resync it or use kapdh_api membershipLabel.
- CI (ops): add `pnpm contracts:test-dart` (needs the Dart SDK on the runner) after contracts:gen. Add a release job that runs `pnpm contracts:release-sdk` and pushes the `contracts-vX.Y.Z` tag. The git dependency URL for the split mobile repo is decided at release time.
- TS API change: `RealtimeEnvelope` is now `RealtimeEnvelope<T extends RealtimeEventType>` (it was a payload generic). Discriminated `RealtimeEvent` and `RealtimePayloads` were added. Nothing in the repo used the old generic.
- Carried over from the builder: OtpVerifyResponse has no required fields (C1 decides); Phase B contract gaps (admin TOTP enrollment, invitations, GET /me/deletion, DELETE /devices, fee quote, event/network/chat/moderation/admin paths); the Flutter app still uses its hand-written API layer, and migrating to kapdh_api (use retryableRequest in the AuthInterceptor, RealtimeEvent for sockets) belongs to mobile-foundation. The intermittent API beforeAll timeout the builder saw under parallel load did not happen in my two full runs; neither file was changed.

## BUILD handoff
Layout and rules:
- Contract source is kapdh-platform/packages/contracts/openapi/root.yaml (shared components only; paths must stay empty) plus openapi/domains/<domain>.yaml. Each domain file may contain only tags, paths and components; every operation needs exactly one tag owned by that file and a camelCase operationId.
- Domain files with paths: auth, admin-auth, account, me, public, payments, admin-payments, files, admin-settings, content, notifications. Domain files with a tag only: events (holds the EventSummary schema), admin-members, admin-masters, admin-content, admin-events, network, chat, moderation, admin-moderation, admin-notifications, admin-dashboard, admin-admins, admin-audit.
- Tag names: Auth, Admin Auth, Account, Me, Public, Payments, Admin Payments, Files, Admin Settings, Content, Admin Content, Events, Admin Events, Network, Chat, Moderation, Admin Moderation, Notifications, Admin Notifications, Admin Dashboard, Admin Admins, Admin Audit, Admin Members, Admin Masters.

Shared components to reference:
- Parameters: #/components/parameters/{Cursor, Limit, IfMatch, IdempotencyKey, ReauthToken, AppVersion, AppPlatform}. Domain parameters: PaymentId (payments), PostSlug (content).
- Responses: #/components/responses/{Error, ValidationError, Unauthenticated, MfaRequired, ReauthRequired, Forbidden, MembershipRequired, AccountSuspended, NotFound, Conflict, RateLimited, FileInvalid, Maintenance, UpgradeRequired}.
- Schemas: #/components/schemas/{Error, ErrorCode, Money, Password, Gender, ClassLevel, EffectiveStatus, AccountStatus, Permission, AdminRole, DevicePlatform}.
- Security schemes: bearerAuth, adminRefreshCookie.

Renames to know about:
- Banner → HomeBanner, Page → PublicPage, Notification → InboxNotification, DeletionRequest → AccountDeletion.
- New body schema names include OtpResendRequest, RefreshRequest, SessionList, ForgotPasswordRequest, ResetPasswordRequest, ChangePasswordRequest, ReauthRequest/ReauthResponse, MasterItemList, PaymentMethodList, CreatePaymentRequest, SubmitPaymentProofRequest, FileUploadRequest, FileAccess, PostPage, NotificationPage, MarkNotificationsReadRequest, RegisterDeviceRequest, AccountDeletionRequest, WebDeletionStartRequest, WebDeletionConfirmRequest, KtaVerifyRequest, AdminLoginRequest, AdminLoginResponse, AdminMfaRequest, HealthStatus.
- The Dart generator rejects schema names that clash with dart:core or common Flutter widget names (State, Route, Card, Badge, ...); prefix them with the domain.

Commands (from kapdh-platform):
- `pnpm contracts:bundle`, `pnpm contracts:lint`, `pnpm contracts:gen` (bundle + TS + Dart), `pnpm --filter @kapdh/contracts test`.
- Dart: `export PATH=/c/flutter/flutter/bin:$PATH`, then `dart.bat pub get && dart.bat analyze && dart.bat test` in packages/contracts/dart/kapdh_api.

Generated, never committed, declared as turbo outputs:
- packages/contracts/dist/openapi.yaml (import as @kapdh/contracts/openapi.yaml).
- src/generated/{api.ts, enums.ts, realtime.ts}.
- dart/kapdh_api/lib/src/**.

TypeScript exports from @kapdh/contracts:
- paths, components, operations, Schemas, ErrorCode, ApiError, EffectiveStatus, AccountStatus, Permission, AdminRole, Money.
- Runtime arrays `<UPPER_SNAKE>_VALUES` for every string enum (ERROR_CODE_VALUES, PERMISSION_VALUES, EFFECTIVE_STATUS_VALUES, PAYMENT_STATUS_VALUES, ...).
- REALTIME_EVENT_TYPES, RealtimeEnvelope, REALTIME_ENVELOPE_VERSION.

@kapdh/shared:
- Exports ERROR_UI (all 21 codes), ERROR_UI_ACTIONS, CLIENT_ERROR_UI (NETWORK, UNKNOWN), errorUiFor(code), isErrorCode, MEMBER_ROUTES, MEMBER_ROUTE_PATH, routeForStatus, MEMBERSHIP_LABEL, MEMBERSHIP_LABEL_UNKNOWN, membershipLabelFor.
- Its src/*.ts may import only TYPES from @kapdh/contracts, because gen-dart transpiles that source and imports it at build time. turbo.json makes packages/shared/src/** an input of @kapdh/contracts#build.

API contract tests (apps/api/test):
- Use `expectOperation(method, path, res)`, where path is the contract template such as "/me/payments/{paymentId}"; it returns the parsed body. It is defined in contract.e2e.test.ts; copy it or move it to test/support (core-api owns support).
- The coverage test fails if any registered Fastify route under /api/v1 has no matching operation in the contract, so add the contract operation before or together with a new controller route.

Dart SDK (package kapdh_api):
- `KapdhApi(dio)` exposes .auth, .me, .payments, .files, .content, .notifications, .account, .public, .adminAuth, .adminPayments, .adminSettings. The class for a tag appears once that tag has operations.
- Methods take path parameters positionally, then a required body, then named query/header parameters plus cancelToken and options.
- RequestOptions.extra keys: kapdhOperationIdKey ('kapdh.operation_id') and kapdhAuthRequiredKey ('kapdh.auth_required', false for public operations).
- ApiException fields: kind, code, ui.action (ErrorUiAction), message, fieldErrors, current, retryAfter, requestId.
- Helpers: routeForStatus(EffectiveStatus) returns MemberRoute? with .path; membershipLabel; Optional<T?> for PATCH fields.
- kapdh-mobile already depends on it by path, so run `pnpm contracts:gen` before `flutter pub get` on a fresh clone.

Envelope schema: packages/contracts/events/envelope.schema.json; add payload schemas as events/<type>.schema.json.

## FIX handoff
**Commands (from kapdh-platform)**
- `pnpm contracts:lint`: bundle, redocly, event catalog validation, eslint.
- `pnpm contracts:gen`: bundle, TS, Dart.
- `pnpm contracts:test-dart`: regenerates the Dart SDK, then runs pub get, `dart analyze --fatal-infos` and `dart test` on dart/kapdh_api and on the fixture package in packages/contracts/.dart_tool/kapdh_api_fixture (gitignored). Dart is found from env DART, PATH, or C:\flutter\flutter\bin.
- `pnpm contracts:release-sdk [--dry-run]`: tags `contracts-v<version>` on a release commit that carries the generated lib/src. Versions in packages/contracts/package.json and dart/kapdh_api/pubspec.yaml must match (both 0.2.0).
- Record breaking contract changes in packages/contracts/CHANGELOG.md.

**API tests**
- `import { expectOperation, expectSchema } from "../support/contract.js";` in apps/api/test/<module>/*.e2e.test.ts.
- Path is the contract template, e.g. "/me/payments/{paymentId}"; the call returns the parsed body.
- `routesMissingFromContract(registeredRoutes(fastify.printRoutes({commonPrefix:false})))` must be [].

**Contract authoring rules added**
- Nullable inline enum: `{ type: [string, "null"], enum: [a, b, null] }`. The generator rejects it if null is missing from `enum`.
- Nullable named enum or ref: `oneOf: [{$ref}, {type: "null"}]`.
- operationIds must not be Dart reserved words.
- 200 plus 204 on one operation is supported and gives a nullable result.

**Realtime events (C6)**
- Payload file: events/<type>.schema.json with `$id` https://kapdh.or.id/contracts/events/<type>.schema.json, title `<Pascal(type)>Payload` (e.g. MessageCreatedPayload, RoomMemberChangedPayload), `type: object`, `additionalProperties: false`, snake_case properties, and examples.
- Remove the type from `x-kapdh-payload-pending` in envelope.schema.json, or move it to `x-kapdh-payload-less` if its payload is always {}.
- Shared schemas go in their own file (title PascalCase, not ending in Payload) and are referenced whole by `$id`; self reference is `"$ref": "#"`.
- Envelope examples must match the payload schema of their type.
- Rules live in scripts/lib/events.mjs; Ajv strict mode accepts the annotation keywords x-kapdh-payload-less, x-kapdh-payload-pending and x-sensitive.

**TS exports from @kapdh/contracts**
- REALTIME_EVENT_TYPES, RealtimeEventType, REALTIME_PAYLOAD_LESS_TYPES, REALTIME_PAYLOAD_PENDING_TYPES, RealtimePayloads.
- `RealtimeEnvelope<T>`, RealtimeEvent (switch on `type` narrows the payload), plus each payload or shared schema exported by its title.

**Dart kapdh_api additions**
- `RealtimeEvent.fromJson(json)`: sealed class with one `<Pascal(type)>Event` subclass per type and `UnknownRealtimeEvent`. Typed types expose a `payload` field; pending types expose a raw `Map` payload getter.
- `ApiFailureKind.unexpected`: not offline; log `cause`.
- `retryableRequest(RequestOptions)`: use it in the 401-refresh interceptor, e.g. `handler.resolve(await dio.fetch<Object?>(retryableRequest(err.requestOptions)))`.
- Multipart request objects can be sent more than once.
- `MemberCardStatus.expired`; `membershipLabel(EffectiveStatus.expired)` == 'KTA Kedaluwarsa'.
- Optional free-form request fields are `Optional<Object?>`.

**Internals**
- Generator core: scripts/lib/dart/generate.mjs, `generateDartSdk({bundle, events, shared})`, which returns `{files, errors, stats}`.
- Fixture inputs: scripts/lib/dart/fixture.mjs.
- turbo: contracts#build, #typecheck and #test all list packages/shared/src/** as inputs.

