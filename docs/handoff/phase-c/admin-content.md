# Phase C slice: admin-content

Final report after build, adversarial review (5 findings) and fixes (commit 0b1f870).

## Summary
I checked all 5 review findings. All were real, and I fixed each one with a test that fails on the old code. The full slice verification passes: build, typecheck, lint, format check, and the admin suite at 196/196 (188 before, net +8 tests).

1. **Save during a cover/banner upload (medium).** ContentImageField now reports its upload state through a new `onUploadingChange` prop.
   - Post editor: while the cover uploads, "Simpan draf/Simpan perubahan" is blocked and says why ("Tunggu unggahan gambar cover selesai sebelum menyimpan."). Pressing Enter does not submit either. The publish panel is blocked too, and leaving the page asks for confirmation.
   - Banner dialog: Save is blocked while the image uploads, with the same kind of reason shown.
   - Tests: editor.test 'PRD 4.5: simpan dan terbit ditahan selama cover diunggah…' and banners.test 'PRD 4.5: simpan banner ditahan…'. Both use a new `mockContent.holdUploads()`.

2. **Wrong person and wrong cause in the conflict notice (medium).** A new `conflictState(error, base)` in contentApi.ts sorts the conflict into one of three causes:
   - `edited`: VERSION_CONFLICT and the version changed.
   - `state_changed`: VERSION_CONFLICT with the same version, for example a scheduled post went live on its own.
   - `unconfirmed`: IDEMPOTENCY_CONFLICT and other reload codes.

   ConflictNotice now words its message by cause and shows "Status terbaru:" from `current` (post state badge, banner state, page published version, category active).
   - Posts no longer name `author`. It is the post's creator, and the contract has no last-editor field. Pages still name `updated_by`.
   - The content mock's `updatePost` no longer overwrites `author`.
   - Tests: editor.test 'AC F15-5: jadwal tiba saat editor terbuka…', the updated AC F15-4 test (no "oleh", latest state shown), and unit tests in content-logic.test.ts.

3. **Event categories handled in two places (medium).** I gave event-category ownership to the events page, which is where guideline p14 puts the "Manajemen Kategori" button.
   - The /content Kategori tab now manages post categories only. Admins who have events.manage see a link to "Event dan Tiket".
   - The `?kind=` search parameter is gone.
   - mocks/content.ts no longer registers /admin/content/event-categories, so after merge the events slice's mock (events.ts) answers those requests and its `eventRequests` checks keep working.
   - Tests: categories.test, three new tests in place of two old ones (event categories not on /content; link hidden without events.manage; an events.manage-only admin gets "Akses ditolak").

4. **Category select loses the category while options load or fail (low).** The post's saved category is always kept as an option.
   - While loading, the select is disabled and shows "Memuat pilihan kategori...".
   - On failure, the select stays enabled with an explanation, the error message and a "Muat ulang pilihan kategori" button.
   - Test: editor.test 'PRD 4.5: pilihan kategori sedang dimuat atau gagal dimuat…', using a new `mockContent.holdCategoryList(fail)`.

5. **Banner dialog hides an unavailable target (low).** When `target.available` is false and the admin has not picked a new target, BannerTargetField shows TargetUnavailableBadge, a reason for that target type, and "Pilih tujuan lain atau nonaktifkan banner."
   - A target that no longer exists shows "(tujuan tidak ditemukan)" in the picker instead of the raw UUID.
   - Test: banners.test 'AC F08-2: dialog ubah banner menjelaskan tujuan tersimpan yang tidak tersedia…', covering an archived post and a deleted post via the new `mockContent.deletePost`.

## AC coverage
- [covered] AC F08-1 (draft/scheduled/archived; scheduling via published_at): Unchanged from builder: posts.test.tsx, editor.test.tsx 'AC F08-1: jadwalkan terbit dengan jam dinding WIB…', content-logic.test.ts.
- [covered] AC F08-2 (banner window; unavailable target handled with a clear message): banners.test.tsx table test plus new 'AC F08-2: dialog ubah banner menjelaskan tujuan tersimpan yang tidak tersedia, juga berita yang sudah dihapus' (badge and reason in the dialog; deleted target shows '(tujuan tidak ditemukan)', never the UUID; the warning clears after picking another target).
- [covered] AC F15-1 (no content permission: menu hidden, page/API refused): access.test.tsx; categories.test.tsx 'AC F15-1: admin konten tanpa events.manage tidak diarahkan ke kategori event' and 'AC F15-1: admin event tanpa content.manage tidak dapat membuka tab Kategori konten' (Akses ditolak, zero content requests).
- [covered] AC F15-4 (stale form gets a version conflict; UI offers reload, shows latest state): editor.test.tsx AC F15-4 now also checks the notice does not name the creator and shows 'Status terbaru: Draf'. Banner, page and category conflict tests still pass with the cause-aware notice. content-logic.test.ts covers conflictState and conflictHeadline.
- [partial] AC F15-5 (scheduled publishing happens once; archived content not revived): Admin UI side: editor.test.tsx 'AC F15-5: jadwal tiba saat editor terbuka → batalkan jadwal ditolak; pemberitahuan menyebut status terbaru, bukan pengurus lain', plus the builder's unschedule/archive/restore tests. Worker/API enforcement belongs to the API content slice.
- [covered] F-01 / PRD 6.2 (legal page versions): Unchanged: pages.test.tsx; the page conflict notice now shows the latest published version.
- [covered] AC F16-3 (permission revoked while open): Unchanged: access.test.tsx.
- [covered] PRD 4.5 loading/error/upload states (review findings 1 and 4): editor.test.tsx 'PRD 4.5: simpan dan terbit ditahan selama cover diunggah…', 'PRD 4.5: pilihan kategori sedang dimuat atau gagal dimuat…'; banners.test.tsx 'PRD 4.5: simpan banner ditahan selama gambar baru diunggah…'.
- [covered] Categories cannot be deleted while in use (p13): categories.test.tsx (in-use delete disabled, FK-restrict race, create then delete) now for post categories only; event categories are owned by the events page (p14).
- [n/a] AC F08-3, F08-4, F15-2, F15-3: Mobile/API or other admin slices.

## Verification
- pass `pnpm build (kapdh-platform)`: 10/10 tasks successful; admin vite build OK (ContentPages chunk 85.4 kB).
- pass `pnpm typecheck (kapdh-platform)`: 15/15 tasks successful.
- pass `pnpm lint (kapdh-platform)`: 9/9 tasks successful; @kapdh/admin eslint ran fresh with no findings.
- pass `pnpm --filter @kapdh/admin test`: 20 files, 196 tests passed (was 188).
- pass `pnpm format:check (kapdh-platform)`: All matched files use Prettier code style.
- pass `npx vitest run src/routes/content (apps/admin)`: The content-only run first showed 2 stale expectations ('Agt' month abbreviation; posts test still expected ?kind=post). I fixed both, then the full suite passed as listed above.

## Contract changes


## Shared changes
- Mock ownership change for the integrator: kapdh-platform/apps/admin/src/api/mocks/content.ts no longer registers /admin/content/event-categories. Before, the mock router's first-match rule and alphabetical loading meant content.ts would answer those requests ahead of mocks/events.ts after merge. The events slice (worktree-wf_2dfc8f13-ce6-11) is now the only mock owner of those paths, and its EventCategoriesSheet on /events is the only event-category UI. No foundation files were edited in this fix. The builder's earlier shared change to RichTextEditorImpl.tsx is unchanged.

## Open issues
- Event-category ownership decision: per guideline p14 and C4 handoff F8, event categories are managed from the events page (admin-events slice EventCategoriesSheet). The content slice no longer offers them and no longer exports CategoryManager (the builder's handoff note suggesting the events slice embed it is withdrawn). If the integrator prefers the opposite split, the content mock routes and UI would need to come back and the events mock routes would need to go.
- The banner event target picker still searches GET /admin/events, which needs events.manage and is mocked by the events slice. Until that merges, event search in dev:mock shows not-found. The content mock keeps a private events map only to resolve banner event targets and their category column.
- PATCH has no last-editor field for posts (AdminPost.author is the creator), so the post conflict notice gives the time and latest state but no editor name. Naming the editor would need an additive `updated_by` on AdminPost from the api-content owner.
- Mock evidence is not proof of the ACs (PRD 7.3). The API content module must enforce If-Match, the publish-time rule, FK in-use rejection and announce-once.

## Handoff notes
Area: kapdh-platform/apps/admin/src/routes/content/** and src/api/mocks/content.ts.

- New and changed APIs:
  - contentApi.ts: `conflictState(error, base)` returns `{cause: 'edited' | 'state_changed' | 'unconfirmed', latest}`; `ConflictCause` / `ConflictState` types; `fetchPostCategoryOptions(ctx)` replaces `fetchCategoryOptions(kind, ctx)`; `contentKeys.categoryList(filters)` and `contentKeys.categoryOptions` are post-only; `ContentCategoryKind` is no longer exported.
  - ConflictNotice: now requires `cause`, takes an optional `latestStatus` ReactNode, and exports `conflictHeadline()`.
  - ContentImageField: new `onUploadingChange(boolean)`.
  - BannerTargetField: new `unavailable` prop.
  - CategoriesTab: takes no props and covers post categories only. It links to /events for admins with events.manage.
  - routes.tsx: ContentSearch is now {tab, page}; `kind` was removed.
- New mock test controls:
  - `mockContent.holdUploads()` returns a release function.
  - `mockContent.holdCategoryList(fail?)` returns a release function and holds the next post-category list request, optionally answering it with a 500.
  - `mockContent.deletePost(id)`.
  - reset() releases any held gates.
  - updatePost keeps `author` as the creator.
