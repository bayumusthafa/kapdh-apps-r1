import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute, guard } from "../__root";

/** Tab halaman /content (guidelines hlm. 13: Banner | Feed Informasi, plus halaman legal dan kategori). */
export const CONTENT_TABS = ["posts", "banners", "pages", "categories"] as const;
export type ContentTab = (typeof CONTENT_TABS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContentSearch {
  tab?: ContentTab;
  /** Tab Halaman: halaman yang sedang disunting (tautan langsung ke editor halaman). */
  page?: string;
}

export function parseContentSearch(search: Record<string, unknown>): ContentSearch {
  const out: ContentSearch = {};
  if (CONTENT_TABS.includes(search.tab as ContentTab)) out.tab = search.tab as ContentTab;
  if (typeof search.page === "string" && UUID.test(search.page)) out.page = search.page;
  return out;
}

/** Manajemen Konten (F-08, F-15). Area content. */
export const contentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/content",
  validateSearch: parseContentSearch,
  beforeLoad: guard("/content"),
  component: lazyRouteComponent(() => import("./ContentPages"), "ContentPage"),
});

export const newPostRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/content/posts/new",
  beforeLoad: guard("/content/posts/new"),
  component: lazyRouteComponent(() => import("./ContentPages"), "PostEditorPage"),
});

export const postRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/content/posts/$postId",
  beforeLoad: guard("/content/posts/$postId"),
  component: lazyRouteComponent(() => import("./ContentPages"), "PostEditorPage"),
});

export const contentRoutes = [contentRoute, newPostRoute, postRoute] as const;
