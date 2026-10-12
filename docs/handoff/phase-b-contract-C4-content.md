# Phase B handoff: contract C4-content

Contract author notes after build, adversarial review and fixes. The domain YAML files are the source of truth; this file explains decisions, open issues and implementation notes for the Phase C slice owners.

## fix summary
I checked all 9 review findings and all 9 were real. I fixed them in kapdh-platform/packages/contracts/openapi/domains/content.yaml and admin-content.yaml, and updated CHANGELOG.md, in commit f97130d on top of the builder's 1a49122.

**The branch is still red on its own.** Finding 1 (HIGH, duplicate /public/pages/{slug}) cannot be fixed inside C4's scope:
- **Merging C2 does not work.** I tried merging C2's branch (49d8c40) into this one. The contract bundled, but `pnpm build` failed in @kapdh/api because C2's me.yaml no longer matches the existing me.service. I aborted the merge.
- **Editing public.yaml myself is ruled out.** It is C2-owned. Changing it would also cause a merge conflict with C2's rewrite of that file.
- **What I did instead:**
  - Made "merge C2 first, or together with C4" a written requirement in the CHANGELOG.
  - Ran every check in two states. With the committed public.yaml, contracts:lint and the contracts tests fail on exactly the 2 duplicate errors. With only the two moved blocks stripped from public.yaml (restored before the commit), everything passes.

Fixes for findings 2-9:
- **Post lifecycle vs the database (F2):**
  - A post that was ever visible keeps its first publish time in published_at. It can never be cleared or moved into the future.
  - Publishing such a post with a future time is rejected (409 VALIDATION_ERROR).
  - Unschedule and archive of a scheduled post clear published_at. A scheduled post always has announced_at null, so posts_announced_chk cannot be violated.
  - slug_locked is defined as published_at not null and ≤ now. No new column is needed.
- **Legal consent version (F3):** GET /public/pages now returns `consent` (LegalConsentVersions) with a combined `policy_version` of the form `privacy:<v>;terms:<v>`. The client sends that value as accept_policy_version. PublicPage.version now means only that document's own version.
- **Home event label (F4):** renamed `not_open_yet` to `not_yet_open`, so it uses the same values as C5's EventRegistrationState minus `cancelled`.
- **Missing 400 responses (F5):** 400 VALIDATION_ERROR is now declared on every operation that takes a uuid path parameter, If-Match or a slug.
- **Sorting (F6):** added sort parameters and enums for the banner, page and category admin tables.
- **Banner "Kategori" column (F7):** AdminBannerTarget.category supplies the column from the category of the banner's target post or event. The deviation from the guideline is written into the contract.
- **Event categories (F8):** category management is now split by kind:
  - `/admin/content/post-categories` requires content.manage.
  - `/admin/content/event-categories` requires events.manage, matching the button on guideline p14.
  - The category schema now has a single `usage_count`.
- **News notification recipients (F9):** the publish description now names the recipients: active members whose effective status is verified or expiring at announce time. Push goes only to those with the news push preference on. The dedup key is `news:<post_id>:<user_id>`, and claiming the post plus writing the inbox items happen in one transaction.

A scratch check found no clashes of paths, operationIds or component names with the other contract branches (C1, C2, C3, C5, C6, C7, core-api), except the known public.yaml duplicate.

## contract/shared changes
- public.yaml (owner C2): must not define path /public/pages/{slug} (getPublicPage) or components.schemas.PublicPage; both live in content.yaml. C2's branch 49d8c40 already removes them. Integration order: merge C2's contract change first (or in the same integration step), never C4 alone to main. Not edited by me.
- auth.yaml (owner C1): accept_policy_version should be documented as LegalConsentVersions.policy_version from GET /public/pages, i.e. the combined 'privacy:<v>;terms:<v>' (pattern ^privacy:[1-9][0-9]*;terms:[1-9][0-9]*$, fits maxLength 64). The server rebuilds it from app_settings.legal and should reject a mismatch, suggested as 409 VERSION_CONFLICT with current = LegalConsentVersions so the client reloads and asks for consent again; C1 decides. While privacy or terms is unpublished, policy_version is null and registration cannot proceed. Existing API tests send '1'/'2026-10' and must be updated when validation is enforced. Not edited by me.
- public.yaml LegalVersions (owner C2): may add policy_version (same combined string) so the splash/config path has it too; GET /public/pages consent is the canonical source. Not edited by me.
- admin-events.yaml (owner C5): event-category management (create/update/delete plus a management table with usage counts) now lives in admin-content.yaml under /admin/content/event-categories with permissions [events.manage]. C5's read-only GET /admin/event-categories (adminListEventCategories) for form pickers stays as is and does not clash. The integrator may move these operations to admin-events.yaml later (a path rename is breaking; record it in the CHANGELOG).
- CHANGELOG.md: the C4 subsection sits under '## Belum dirilis'. C2's branch also adds that heading, so expect a trivial merge conflict: keep one heading with both subsections (tested resolution: C2 subsection first, then C4).

## open issues
- Branch alone is not green: contracts:lint, the @kapdh/contracts build and test, and therefore pnpm build/typecheck/test fail on f97130d until C2's public.yaml change is merged. All checks pass in the post-C2 state. I could not rebase onto C2: C2's 49d8c40 breaks the @kapdh/api build because me.yaml no longer matches the existing me.service.
- Product decision still open: GET /home, /posts, /posts/{slug} and likes are member_access=active (PRD 1.4/2.2). If news should be readable by unverified/expired members, change getHome/listPosts/getPost to nonsuspended and widen the announce recipient set to match.
- Banners have no category of their own in R1.0. The p13 'Kategori' column is filled from target.category (the target post/event category). If the product wants independent banner categories, that needs a DB migration (banners.category_id) and a contract addition.
- No per-post opt-out for the news notification: every post is announced once when it becomes visible. An opt-out needs a DB column.
- HomeEvent stays content-local. Its registration_state values now match C5's EventRegistrationState (minus cancelled). After C5 merges, the integrator may replace HomeEvent with EventSummary; that is a breaking change and must go in the CHANGELOG.
- Composite consent covers privacy and terms only (F-01). Community guidelines (ketentuan-komunitas) are versioned and published but not part of the registration consent string. If store UGC review requires explicit acceptance before chat, C6 (community) should record it separately.
- Republishing a previously visible post keeps its original published_at (Tgl Publikasi) and feed position, per the invariant. If the product wants republished posts to move to the top of the feed, published_at = now on republish also satisfies the DB constraints; that is a documented choice, not a technical limit.

## handoff
Operations (METHOD path operationId access):
Content tag (content.yaml):
- GET /home getHome {audience: mobile, member_access: active}
- GET /posts listPosts {mobile, active}; query cursor, limit, category (post category slug)
- GET /posts/{slug} getPost {mobile, active}; 400/401/403/404
- PUT /posts/{slug}/like likePost {mobile, active}; idempotent by nature (no Idempotency-Key); LikeState
- DELETE /posts/{slug}/like unlikePost {mobile, active}; 200 LikeState even if no like existed
- GET /categories listCategories {audience: any}; query kind (ContentCategoryKind)
- GET /public/pages listPublicPages {audience: public, security: []}; returns PublicPageList {items, consent: LegalConsentVersions}
- GET /public/pages/{slug} getPublicPage {public, security: []}; 400/404/429
Admin Content tag (admin-content.yaml):
- GET /admin/content/posts adminListPosts {admin, [content.manage]}; q, state, category_id, sort (AdminPostSort), cursor, limit
- POST /admin/content/posts adminCreatePost {admin, [content.manage], idempotent}
- GET|PATCH|DELETE /admin/content/posts/{postId} adminGetPost / adminUpdatePost / adminDeletePost {admin, [content.manage]} (PATCH and DELETE need If-Match)
- POST /admin/content/posts/{postId}/publish adminPublishPost {admin, [content.manage], idempotent} (If-Match; body AdminPostPublishRequest {published_at?})
- POST /admin/content/posts/{postId}/unschedule|archive|restore adminUnschedulePost / adminArchivePost / adminRestorePost {admin, [content.manage], idempotent} (If-Match)
- GET|POST /admin/content/banners adminListBanners (q, state, sort AdminBannerSort, cursor, limit) / adminCreateBanner (idempotent) {admin, [content.manage]}
- GET|PATCH|DELETE /admin/content/banners/{bannerId} adminGetBanner / adminUpdateBanner / adminDeleteBanner {admin, [content.manage]}
- GET|POST /admin/content/pages adminListPages (q, sort AdminInfoPageSort, cursor, limit) / adminCreatePage (idempotent) {admin, [content.manage]}
- GET|PATCH|DELETE /admin/content/pages/{pageId} adminGetPage / adminUpdatePage / adminDeletePage {admin, [content.manage]}
- POST /admin/content/pages/{pageId}/publish adminPublishPage {admin, [content.manage], idempotent} (If-Match; body AdminInfoPagePublishRequest {change_note?})
- GET|POST /admin/content/post-categories adminListPostCategories (active, q, sort AdminContentCategorySort, cursor, limit) / adminCreatePostCategory (idempotent) {admin, [content.manage]}
- GET|PATCH|DELETE /admin/content/post-categories/{categoryId} adminGetPostCategory / adminUpdatePostCategory / adminDeletePostCategory {admin, [content.manage]}
- GET|POST /admin/content/event-categories adminListManagedEventCategories / adminCreateEventCategory (idempotent) {admin, [events.manage]}
- GET|PATCH|DELETE /admin/content/event-categories/{categoryId} adminGetEventCategory / adminUpdateEventCategory / adminDeleteEventCategory {admin, [events.manage]}
- POST /admin/content/media adminUploadContentMedia {admin, [content.manage]} (multipart: purpose post_cover|banner_image, file)
Removed versus the builder commit (never on main): adminListCategories, adminCreateCategory, adminGetCategory, adminUpdateCategory, adminDeleteCategory and the /admin/content/categories paths.

Main schemas:
- content.yaml: Home, HomeBanner, HomeBannerTarget, BannerTargetType, HomeEvent, HomeEventRegistrationState [not_yet_open, open, sold_out, closed], HomeQuickAccess, PostSummary, Post, PostPage, LikeState, ContentCategoryKind, ContentCategoryRef, ContentCategory, ContentCategoryList, PageLegalDocument, LegalConsentVersions {policy_version, privacy_version, terms_version}, PublicPageSummary, PublicPageList {items, consent}, PublicPage; parameter PostSlug.
- admin-content.yaml: AdminContentActor, ContentImage, AdminPostState, AdminPostSort, AdminPostSummary, AdminPost (slug_locked), AdminPostPage, AdminPostCreateRequest, AdminPostUpdateRequest, AdminPostPublishRequest, AdminBannerState, AdminBannerSort [sort_order_asc, starts_at_desc, updated_at_desc, title_asc], AdminBannerTarget {type, value, available, label, route, category}, AdminBanner, AdminBannerPage, AdminBannerCreateRequest, AdminBannerUpdateRequest, AdminInfoPageSort [system_first, title_asc, updated_at_desc, published_at_desc], AdminInfoPagePublished, AdminInfoPageSummary, AdminInfoPage, AdminInfoPageList, AdminInfoPageCreateRequest, AdminInfoPageUpdateRequest, AdminInfoPagePublishRequest, AdminContentCategorySort [sort_order_asc, label_asc, usage_desc, updated_at_desc], AdminContentCategory (usage_count; post_count/event_count removed), AdminContentCategoryPage, AdminContentCategoryCreateRequest {label, slug?, sort_order?, active?} (kind comes from the path), AdminContentCategoryUpdateRequest, ContentMediaPurpose, AdminContentMediaUploadRequest, ContentMedia; parameters ContentPostId, ContentBannerId, ContentPageId, ContentCategoryId.

Rules the content API module must implement:
- Post publish-time invariant: once a post has been visible (status published and published_at <= now), published_at holds the first visible time and is never cleared or moved into the future.
  - publish: a never-visible draft accepts null (now) or a future time. A draft that was visible before (slug_locked) accepts only null and keeps its original published_at; a future time gives 409 VALIDATION_ERROR (field_errors.published_at). A past time gives 400.
  - unschedule: conditional UPDATE ... WHERE version=:v AND status='published' AND published_at > now AND announced_at IS NULL, setting status=draft and published_at=NULL.
  - archive: SET status='archived', published_at = CASE WHEN published_at > now THEN NULL ELSE published_at END.
  - restore: archived -> draft; published_at and announced_at unchanged.
  - slug_locked = published_at IS NOT NULL AND published_at <= now. AdminPostState is derived from status and published_at, never stored.
- content.announce, in ONE transaction:
  - UPDATE posts SET announced_at=now WHERE status='published' AND published_at<=now AND announced_at IS NULL RETURNING.
  - Insert inbox notifications (category news, route /news/{slug}, dedup_key 'news:<post_id>:<user_id>', ON CONFLICT DO NOTHING) for alumni users whose account status is active and effective_status is verified or expiring.
  - Push only when the news push preference is enabled (a missing notification_preferences row counts as enabled). News has no email channel.
- Legal consent: policy_version = 'privacy:' + app_settings.legal.privacy_version + ';terms:' + terms_version; null when either is null. Page publish mirrors app_settings.legal.<doc>_version in the same transaction.
- Category kind is taken from the path; an id of the other kind gives 404. Deleting a category that is in use: FK RESTRICT (23503/23001) gives 409 VALIDATION_ERROR. usage_count counts posts or events in every state.
- Banner target.category is the target post's or event's category ref; null for none/page/url or a missing target.
- 409 convention: stale version or a transition that is no longer valid gives VERSION_CONFLICT with current. Conflicts a reload cannot fix (slug taken, category in use, seeded page, nothing to publish, rescheduling a post that was visible) give VALIDATION_ERROR with field_errors.
- Dart SDK: api.content.listPublicPages() returns .consent.policyVersion; api.adminContent.adminCreateEventCategory(AdminContentCategoryCreateRequest(...), idempotencyKey: k); HomeEventRegistrationState.notYetOpen.
