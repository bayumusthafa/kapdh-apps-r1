# Phase C slice: api-chat

Final report after build, adversarial review (5 findings) and fixes (commit d6d3b0b5bb21342618a9c86ae890aa3946679a70).

## Summary
I checked all 5 review findings for api-chat. All 5 were real, all are fixed, and none were rejected. For each one I first wrote a test, saw it fail against the old code (findings 3 and 5 by running the test; finding 2 by temporarily reverting the fix), then fixed it. The work is in 3 commits on top of the builder's fa51ad0: 94ada9a and 051d770 are checkpoints, d6d3b0b is the final fix commit. Every check passed on the final code.

1. **(F1) Deleted user's name stayed in group system messages (AC F14-3).** System messages no longer store names. The message body now holds a small JSON record with only user IDs and the group name (new file chat.system-messages.ts). The server builds the display text when the message is read, using the user's current name. A deleted account shows as "Seorang anggota". This applies everywhere: history, the room list preview, reply previews and realtime events. Admin name corrections also show up automatically. Old plain-text bodies are shown unchanged. Other modules that read message bodies straight from the database can call `ChatPresenter.renderSystemBodies`. New test: before deletion the name never appears in any stored body; after deletion it appears nowhere in history, the room list or stored bodies.

2. **(F2) Image and avatar links in realtime events could be opened without a permission check (PRD 5.4, AC F11-4).** The builder's 120-second unbound links are gone. Events that carry a private link (a new message with an image or a private sender avatar, and room.updated with a group avatar) are now sent separately to each recipient device. Each copy carries a link tied to that device's session, so opening it re-checks access, exactly like HTTP responses.
   - Recipients are worked out after commit using the same rules as the room channel: joined members with active status and an active session. For messages, members who joined after the message are excluded.
   - Each device still gets exactly one copy. Events without private links still go once to the room channel.
   - This needed one small addition to core: `RealtimeService.emitToSession`.
   - New tests: links differ per session and work at first; after the member is removed every link they received returns 404 while other members' links still work; a removed member gets no room.updated; a delayed send never reaches a member who joined after the message.

3. **(F3) Pending invitees' avatars showed as broken images.** The avatar access rule now lets a joined group admin open the avatar of someone with a pending invitation to an open group. Test: every avatar_url in the invited list opens; a regular member gets 404; after the invitation is cancelled the issued link returns 404.

4. **(F4) Members who muted a room or turned off chat push got no inbox entry (AC F13-2).** The inbox notification is now written for every active member. Muting or turning off chat push only stops the push. This needed one small addition to core: a `NotifyInput.externalDelivery: false` option that writes the inbox entry and realtime event but no outbox row. Tests check that both muted and opted-out members get an inbox entry with no push queued, while normal members get both.

5. **(F5) The uploader could still open their chat image after leaving the room (AC F11-4).** The chat module's image rule now replaces core's default "owner can always open" rule for chat images. This uses a new `replaceDefaults` option on `FilesService.registerAccessPolicy`; it removes only core's built-in rules, so rules added by other modules (such as a moderation evidence rule) still work. An uploader can still preview their own image before it is sent. Tests: after leaving, the sender can no longer open their message image or a link already issued to them; a former admin can no longer open the group avatar they uploaded; an extra rule added by another module still grants access.

Contract files changed only in descriptions (chat.yaml, three event schema files, events/README.md and a CHANGELOG entry). No operations or fields changed, and there are no migrations.

## AC coverage
- [covered] AC F11-1 (one canonical direct room under concurrent creation): Unchanged from the builder: chat-rooms.e2e 'AC F11-1: dibuka dari kedua pihak...'; test/pg/chat.pg.test.ts concurrent creation from both sides with an observed lock wait, plus 6 ungated pairs; still green (pg 73/73).
- [covered] AC F11-2 (ack after commit; repeated client_message_id returns the same message): chat-messages.e2e 'AC F11-2: pesan valid 201...'; chat.pg concurrent duplicates and cross-room 201/409; chat-realtime 'AC F11-2: pesan sampai ke anggota room...' (text message, one copy per device, same shape as the HTTP response) still green after the delivery change.
- [covered] AC F11-3 (sync after reconnect without loss or duplication): chat-realtime 'AC F11-3: pesan yang commit selama socket terputus...'; chat.pg 30 concurrent sends with an after-sync reader; both green.
- [covered] AC F11-4 (non-member or departed member denied history, file and subscribe): New chat-access 'AC F11-4: pengunggah gambar pesan atau avatar grup yang sudah keluar room tidak lagi dapat membukanya...' (F5) and 'AC F11-4: kebijakan chat_image tambahan dari modul lain...'. New chat-realtime 'PRD 5.4 / AC F11-4: URL gambar dan avatar privat pada message.created dan room.updated terikat sesi penerima...' (F2: links received by a removed member return 404). Existing departed-member, IDOR and outsider tests still green.
- [covered] AC F11-5 (last admin must transfer; account deletion uses system reassignment): chat-rooms 'AC F11-5...' tests and chat-lifecycle detachDeletedAccount test; the system reassignment message is now the structured event 'admin_reassigned' and still renders '... sekarang admin grup ...'.
- [covered] AC F11-6 (member who becomes expired/suspended while connected is refused and unsubscribed): chat-access status matrix on all 20 operations; chat-realtime expiry and suspend tests. Per-session delivery only sends to members whose account is active, not suspended and not expired, with an active session.
- [covered] AC F12-1 (blocks stop direct send and invites both ways; history stays): Unchanged builder tests (chat-rooms, chat-messages, chat-realtime send_permission) still green; room.updated send_permission now goes through ChatEvents.roomUpdated with toUserId.
- [covered] AC F14-3 (chat content of a deleted account removed or turned into placeholders; no name left): New chat-lifecycle 'AC F14-3: pesan sistem menyimpan id pengguna tanpa nama; setelah akun dihapus seluruh riwayat dan daftar room menampilkan Seorang anggota': stored bodies never contain the name; after detachDeletedAccount and status deleted, the history JSON, the room list and renderSystemBodies output contain no name and show 'Seorang anggota ...' for joined, admin granted, rename, removed-by and left-by-deletion.
- [covered] AC F13-2 / PRD 3.13 (inbox always written; turning off a category or muting only stops push): Rewritten chat-messages 'AC F13-2 / AC F11-6: inbox ditulis untuk setiap anggota aktif (juga yang mute atau mematikan push chat)...': opted-out and muted members each get 1 inbox entry with 0 outbox rows; normal member gets inbox plus outbox; inactive member and sender get none; one notification per unread episode. chat-rooms 'PRD 3.11: mute hanya menahan push (pesan, unread dan inbox tetap tersedia)...'.
- [covered] PRD 3.11 group rules (max 100 incl. invites, admin-only invites, invitee must accept, history from join): Builder tests still green, plus new chat-realtime 'PRD 3.11: penyiaran per sesi yang tertunda tidak mengirim pesan sebelum penerima bergabung (history_visible_from)' and chat-rooms 'PRD 3.11 (N-09): admin grup dapat membuka avatar calon anggota pada daftar undangan...' (F3).
- [covered] PRD 3.11 read cursor monotonic; messages up to 4000 chars, images, replies, reactions, delete, mute, typing/presence TTL: Unchanged builder tests (chat-messages, chat-rooms, chat-realtime, chat.pg read-cursor races) all green.
- [covered] N-02 (committed message reaches online receivers; reconnect fetches missed messages): chat-realtime delivery, per-session delivery and reconnect tests; chat.pg sync test.
- [partial] AC F14-5 (account deletion side: sole-admin disclosure and reassignment called by the account job): ChatLifecycleService.soleAdminGroupCount and detachDeletedAccount are tested (also loadable in the worker); calling them from the account deletion job belongs to the api-account slice.

## Verification
- fail `npx vitest run test/chat (apps/api), new tests before the fix`: Expected failures that confirm the findings: the F5 uploader-after-leave test got 200 instead of 404, and the F3 invitee-avatar test got 404 instead of 200. F2 was confirmed by temporarily making realtime links session-less: the new realtime test failed, and the code was restored. F4 is shown directly by the old filter code; the old test even asserted an empty inbox.
- pass `pnpm build (kapdh-platform)`: 10/10 tasks.
- pass `pnpm typecheck`: 15/15 tasks.
- pass `pnpm lint`: 9/9 tasks; only the 2 known contract warnings (no-ambiguous-paths). API eslint on src and test is clean.
- pass `pnpm test`: 15/15 tasks: API 463/463 (458 before plus 5 new chat tests; existing chat tests updated), admin 143, database 23, storage 33, config 23, shared 16, web 5.
- pass `pnpm --filter @kapdh/api test:pg`: 11 files, 73/73 on PostgreSQL 17, including the 7 chat race tests.
- pass `pnpm contracts:lint`: Bundle valid with the 2 known warnings; events: 17 schemas valid, 20 examples pass, 10 typed event types.
- pass `pnpm format:check`: All matched files use Prettier code style.
- pass `PATH=/c/flutter/flutter/bin:$PATH pnpm contracts:test-dart`: Run because contract descriptions changed: Dart SDK passes analyze (no info) and tests.

## Contract changes
- kapdh-platform/packages/contracts/openapi/domains/chat.yaml (description only): header rules now say private file links in HTTP responses and realtime events are tied to the recipient's session and that events carrying them go per session family; system message text is built by the server with current names, and deleted accounts show as 'Seorang anggota'. ChatImage and ChatMessage.body descriptions updated. sendChatMessage and setChatRoomMute now say the inbox notification is still written when a member muted the room or turned off chat push; only push is held.
- kapdh-platform/packages/contracts/events/message.created.schema.json, realtime-chat-image.schema.json, room.updated.schema.json (description only): per-session delivery and session-bound links.
- kapdh-platform/packages/contracts/events/README.md: channel notes and table updated (message.created and room.updated use session:<id> when they carry private links).
- kapdh-platform/packages/contracts/CHANGELOG.md: three entries under 'Komunitas (C6)' for these behaviour rules. No payload or schema shape changed and no operation changed.

## Shared changes
- kapdh-platform/apps/api/src/core/files/files.service.ts (core-api owned, additive): registerAccessPolicy(purpose, policy, {replaceDefaults?: boolean}). Core's built-in rules are now kept separately from module rules; replaceDefaults turns off only core's built-in rules for that purpose, so rules added by other modules still apply whatever order modules start in. The chat module uses it for chat_image, which turns off the unconditional owner rule.
- kapdh-platform/apps/api/src/core/realtime/realtime.service.ts (core-api owned, additive): new emitToSession(familyId, type, entityId, payload), which sends to the session:<familyId> channel and is deferred until commit like the other emit methods.
- kapdh-platform/apps/api/src/core/notifications-kernel/notification.service.ts (core-api owned, additive): NotifyInput.externalDelivery?: boolean, default true. When false, notify() writes the inbox row and the realtime notification.created event but publishes no outbox notification.created, so no push or email is scheduled. Chat uses it for muted rooms and turned-off chat push. The notifications worker needs no change.
- kapdh-platform/apps/api/test/core/realtime.e2e.test.ts: the builder's earlier change (vi.spyOn on clientHandler) is kept unchanged.

## Open issues
- No finding was rejected: all 5 were confirmed and fixed with tests.
- Moderation slice (api-moderation): system message bodies in app.messages are now JSON records (user IDs plus group name, no names). When report evidence copies context messages of kind 'system', it must turn them into text with ChatPresenter.renderSystemBodies(db, bodies) (exported through ChatLifecycleModule), otherwise admins will see raw JSON. Moderation must also register its own additive chat_image rule so admins can open evidence images: core's owner rule no longer applies to chat_image, and the chat rule only allows active mobile room members. A test shows such an extra rule still works.
- Carried over from the builder: moderation must call ChatLifecycleService.onBlockCreated / onBlockRemoved / removeMessage; the account slice must import ChatLifecycleModule in AccountJobsModule and call detachDeletedAccount(userId) before users/files rows are deleted, plus soleAdminGroupCount for AC F14-5. Rendering now also anonymises system messages once users.status is 'deleted' or the users/alumni row is gone, so the account job does not need to rewrite system messages.
- Performance (N-02): a message with a private image or private sender avatar is sent per recipient session after commit. That means one recipient query plus one signed link per session per private file, and the HTTP ack waits for it (afterCommit callbacks are awaited, the same as NotificationService). For a 100-member group this is a few hundred HMAC signatures per message; load testing is recommended before launch.
- Carried over from the builder: the sender's status is checked by AuthGuard at the start of the request and not re-read under the room lock, so a suspension that commits during an in-flight send can still let that one message through. No offline presence is broadcast on socket disconnect; clients rely on the presence TTL.

## Handoff notes
Changes on top of the builder's layout (apps/api/src/modules/chat):

- **chat.system-messages.ts (new):**
  - `SystemEvent` union: group_created, group_renamed, group_photo_changed, group_photo_removed, member_joined, member_left, member_removed, admin_granted, admin_revoked, admin_reassigned, deleted_member_left.
  - Functions: encodeSystemEvent, decodeSystemEvent, renderSystemEvent, systemText.
  - `ChatWriter.systemMessage(tx, roomId, event)` now takes a SystemEvent instead of a string.
  - Stored body: `{"v":1,"type":...,"user"/"actor":<uuid>,"name"?}`. Plain-text bodies render unchanged.
- **ChatPresenter:**
  - New: `summaries(db, rows, viewer)`, `room(db, row, viewer)`, `nameLookup(db, bodies)`, `renderSystemBodies(db, bodies)` (public, for moderation evidence), static `hasPrivateFiles(row)`, `systemBodies(rows)`.
  - `fileUrl()` never issues a private link without a viewer.
  - Removed: `REALTIME_FILE_URL_TTL_SECONDS`.
- **ChatEvents** now owns all chat realtime sending (dependencies: RealtimeService, ChatPresenter, DB, CLOCK, ROOT_LOGGER; all worker-safe):
  - `messageCreated(roomId, messageId)` and `roomUpdated({roomId, version, changes, name, avatar, closedAt, toUserId?})`.
  - Both build the payload from the database after commit.
  - Private links go per session family through `sessionRecipients()` (chat.queries.ts: active joined members with an active mobile session; latest row per family plus session_version; optional `messageId` applies history_visible_from).
  - Events without private links go once to room:<id> or user:<id>.
  - Nothing is queried when the transport is 'none'.
- **ChatMessagesService.scheduleNotifications** (renamed from schedulePush):
  - Inbox entry for every active joined member except the sender.
  - `externalDelivery: false` when the room is muted or chat push is turned off.
- **chat.realtime.ts:**
  - chat_image is registered with `replaceDefaults: true`; the owner can open only their own upload that is not yet attached.
  - The avatar rule also lets a joined group admin see pending invitees in open groups.

For Flutter (network-chat):
- Image and avatar links in socket events now behave like HTTP ones: tied to the session, valid for at most 10 minutes, and access is re-checked when opened. After expiry use GET /files/{id}/access or reload the history page.
- A member's devices each receive their own copy of message.created / room.updated; dedupe by event_id or message id as before.
- System message bodies arrive as finished text.

Test helpers added to test/chat/support.ts: `setAvatar(t, member)` (attached private avatar), `fileUrlPath`, `openFileUrl(t, url)` (opens without an Authorization header).
