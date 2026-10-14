# Phase C slice: api-moderation

Final report after build, adversarial review (5 findings) and fixes (commit dcf6f5981c8ebabeced51a85bb2293f76678fa80).

## Summary
I checked all 5 review findings for the api-moderation slice and all 5 were real. I fixed each one and added or extended a test for it. I ran the 5 changed tests against the old source first (source fixes stashed), and all 5 failed. After the fixes, the 48 moderation tests pass, and so does the full verification run.

1. **(medium) Evidence reads in claim and resolve responses were not audited.** This was worse than reported: the first claim also wrote no `moderation.report_viewed` row, not just re-claims. Now every response that contains evidence goes through one helper, `auditedDetail`, in apps/api/src/modules/moderation/admin-reports.service.ts. It covers GET detail, claim (including an idempotent re-claim), resolve, and the `current` body on a 409. Each one writes a `moderation.report_viewed` audit before the response is sent. The audit records `after.via` (detail, claim, resolve or conflict), the evidence message ids and the ids of image files whose signed URL was issued. It never stores content or URLs.

2. **(medium) D2 / AC F14-3: free text written by a deleted user was still kept and shown.** The admin detail now returns `description` null when the author's account is deleted. The author is the reporter, or the appellant for an appeal. `anonymizeEvidenceOf` (evidence-anonymize.ts) now also clears `reports.description` for reports that user wrote, and it is still idempotent. Admin-written records stay as the organisation's decision record: `resolution_note`, `member_message` and the contested-suspension snapshot.

3. **(low) A cancelled invitation counted as room membership.** An invitation cancelled before acceptance (invited → removed, joined_at empty) made the invitee reportable and allowed them to be picked as a group-report subject. A new helper `everJoinedRoom` (room-membership.ts) requires status joined, left or removed with `joined_at` set. Both `createReport` (sharedRoom) and `validateDecision` (subject_user_id) use it.

4. **(low) Test titles claimed more than the tests prove.** The AC F12-4 test is renamed so it claims only what it checks: sessions and community access revoked, effective_status suspended, and the profile no longer reachable for members without a shared room. The AC F12-1 title now says BlockPolicy rejects both directions. Comments name the slices that own the real end-to-end proofs.

5. **(low) Wrong audit actor on stale-appeal closure.** When `createAppeal` closes a stale appeal, the `moderation.report_resolved` audit now uses SYSTEM_ACTOR (effective_role system, `after.closed_by` system) instead of the appellant.

The contracts only got wording changes in domains I own; no shapes changed. Everything is recorded in CHANGELOG.

## AC coverage
- [partial] AC F12-1 (blocks are two-way; cannot block yourself): blocks.e2e.test.ts 'AC F12-1: blokir dari satu pihak membuat BlockPolicy menolak kedua arah…' proves BlockPolicy.isBlockedEitherWay both ways, plus cancelled invites, self-block 400 and authz. Rejection of a real direct send (sendChatMessage) has to be proven end to end by the api-chat slice. The chat module does not exist in this worktree.
- [covered] AC F12-2 (report on something the reporter can reach is recorded, trackable by the reporter, hidden from the reported member; urgent 24 h / 2 business days): reports.e2e.test.ts covers user, message and group reports, the reachability 404s, SLA and hiding from the reported member. NEW 'AC F12-2: undangan yang dibatalkan sebelum diterima bukan pernah satu room (404)…' uses the real block flow (invite cancelled, then unblock): result 404 and no report. A member removed after joining still gives 201. Also covered: the admin-queue conflict-of-interest tests and the pg lane test for parallel reports.
- [covered] AC F12-3 (dismiss/warn/suspend/unsuspend record reason, actor, time and evidence; warn leaves dates unchanged): admin-reports.e2e.test.ts covers the dismiss and warn tests and the other resolve tests. The group-report test now also checks that a cancelled invitee (removed, joined_at null) as subject_user_id gives 400 with no membership_event. reports.e2e stale-appeal test 'AC F12-3: jaring pengaman…' checks the audit actor is system (actorUserId and actorAdminId null, effectiveRole system, closed_by system), while appeal_created stays under the appellant. pg lane test for double decisions.
- [partial] AC F12-4 (after suspend: sessions/community access revoked, directory hides, KTA verify inactive): admin-reports.e2e 'AC F12-4: suspend (konfirmasi wajib) mencabut semua sesi dan akses komunitas; effective_status suspended; profil tidak lagi terjangkau…' covers confirm required, old token 401, all sessions revoked, session.revoked, 403 ACCOUNT_SUSPENDED after logging in again, and effective_status suspended. GET /directory hiding and public verifyKta inactive need e2e tests in the api-network and api-membership slices, which are not in this worktree.
- [covered] AC F12-5 (unsuspend recomputes status from expires_at): admin-reports.e2e 'AC F12-5: unsuspend menghitung ulang dari expires_at…', reports.e2e 'AC F12-5: unsuspend dari menu anggota…', and the pg lane concurrency test all pass unchanged.
- [covered] AC F17-1 / PRD 3.12 (evidence access restricted and audited): NEW admin-reports.e2e 'AC F17-1: setiap respons klaim (termasuk klaim ulang idempoten) dan keputusan yang memuat bukti tercatat sebagai pembacaan bukti'. The first claim plus 3 re-claims give 4 report_viewed rows (via claim, actor admin, message and image ids, no content or URLs) and still only 1 report_claimed. Resolve adds 1 report_viewed via resolve. Existing GET detail and 409 tests still pass.
- [covered] D2 / AC F14-3 (moderation reports kept only in anonymous form after account deletion): NEW reports.e2e 'AC F14-3 / D2: deskripsi laporan dan alasan banding tulisan akun yang dihapus tidak ditampilkan lalu dikosongkan…'. For a deleted reporter and a deleted appellant, the detail shows description null before the job runs. anonymizeEvidenceOf clears both descriptions, returning 2, then 0, then 1, then 0. Another member's report about the deleted user keeps its description while the profile snapshot is scrubbed. No phone number, name or address remains in the stored rows. The existing evidence-anonymisation test still passes.
- [covered] Decorators match x-kapdh-access: admin-queue.e2e 'x-kapdh-access modul moderation' still passes. No routes changed.

## Verification
- fail `npx vitest run test/moderation -t <5 new/changed tests> (with source fixes stashed)`: Done on purpose to prove the tests catch the bugs: all 5 new or extended tests failed on the old code (claim audit [] vs 1; cancelled invitee warn 200 vs 400; cancelled-invite report 201 vs 404; description shown vs null; stale-appeal actor alumni vs system). The fixes were then restored.
- pass `npx vitest run test/moderation src/modules/moderation (apps/api)`: 5 files, 48/48
- pass `pnpm build`: 10/10 tasks (contracts regenerated)
- pass `pnpm typecheck`: 15/15 tasks
- pass `pnpm lint`: 9/9 tasks; only the 2 known Redocly warnings
- pass `pnpm test`: exit 0, 15/15 tasks: API 452/452 (36 files), admin 143/143, database 23, config 23, storage 33, shared 16, web 5
- pass `pnpm --filter @kapdh/api test:pg`: exit 0, 11 files, 70/70
- pass `pnpm contracts:lint`: Valid with the 2 known warnings; 17 event schemas valid
- pass `pnpm format:check`: All matched files use Prettier code style
- not_run `pnpm contracts:test-dart`: Not in this slice's verify list. The contract changes are description text only, so the generated Dart types do not change.

## Contract changes
- Wording-only, backward-compatible changes in domains this slice owns (no schema or shape changes):
- admin-moderation.yaml: the domain rule now says every response that contains evidence (detail, claim including idempotent re-claim, resolve, and `current` on 409) writes moderation.report_viewed.
- admin-moderation.yaml: adminClaimReport description now mentions the report_viewed audit.
- admin-moderation.yaml: adminResolveReport and AdminModerationResolveRequest.subject_user_id now say 'mantan anggota' means someone who actually joined; a cancelled invitation does not count.
- admin-moderation.yaml: AdminModerationReportDetail.description now says it is null when its author's account is deleted (D2).
- moderation.yaml: createReport target user 'pernah berada di room yang sama' now requires that both members actually joined.
- packages/contracts/CHANGELOG.md: section 'Ketergantungan lintas domain C6', status block, gained notes on all of the above plus the system actor for stale-appeal closure.

## Shared changes
- None outside the api-moderation slice in this fix round. No core files and no migrations were touched.
- Carried over from the builder round (already on this branch): core apps/api/src/core/membership/membership.kernel.ts (unsuspend closes appeals), core apps/api/src/core/files/files.service.ts (evidence file retention), and apps/api/test/pg/moderation.pg.test.ts.

## Open issues
- Cross-slice proofs still to be written by their owners: AC F12-4 (after suspend, GET /directory excludes the member and public verifyKta shows inactive) by api-network and api-membership; AC F12-1 (block, then sendChatMessage and group invite rejected both ways) by api-chat. Each needs its own e2e test. The moderation side, effective_status suspended and BlockPolicy, is proven here.
- The account slice (F-14 deletion job) must call anonymizeEvidenceOf(tx, userId, now) from apps/api/src/modules/moderation/evidence-anonymize.ts. It now also clears reports.description written by that user. Until it is called, the stored evidence and descriptions of deleted users remain in the database, although the admin view already hides them.
- The admin slice must use ModerationVisibility.dashboardSummary and memberReportCounts for the dashboard, nav badges and AdminMemberDetail.moderation (admin-moderation rule c).
- Idempotency-Key replay of claim or resolve is handled by the core idempotency layer. It returns the stored first response, with the same URLs already audited at first delivery, and writes no new report_viewed row. This is by design and not a new evidence read.
- Carried over: FilesService.isRetainedAsEvidence has no GIN index on reports.evidence -> 'file_ids'; a moderation.read admin can get a new evidence signed URL through GET /files/{id}/access, and that path is not audited separately; warnings cannot be appealed in R1.0 (C6 product decision).

## Handoff notes
Commits on worktree-wf_b8bd7d01-232-8 after the builder's c323584: d06cc4d (wip) and dcf6f59 (fix, final).

Files changed in kapdh-platform:
- apps/api/src/modules/moderation/admin-reports.service.ts: auditedDetail and responseDetail helpers; evidenceImageIds; description hidden for a deleted author; everJoinedRoom in validateDecision.
- apps/api/src/modules/moderation/reports.service.ts: everJoinedRoom in sharedRoom; SYSTEM_ACTOR for stale-appeal closure.
- apps/api/src/modules/moderation/evidence-anonymize.ts: also clears the description authored by the user.
- apps/api/src/modules/moderation/room-membership.ts: new file, `everJoinedRoom(status, joinedAt)`.
- Tests: apps/api/test/moderation/{admin-reports,reports,blocks}.e2e.test.ts; the fixtures.ts addRoomMember helper gained a `joinedAt` override.

For other slices:
- **Chat:** to decide whether someone "was ever a member" for moderation purposes, use `everJoinedRoom(status, joined_at)`, not the status alone.
- **Account deletion job:** `anonymizeEvidenceOf` now also clears the descriptions that user wrote, so no extra step is needed.

Audit consumers (admin-audit slice) will see `moderation.report_viewed` rows with `after.via` set to detail, claim, resolve or conflict.
