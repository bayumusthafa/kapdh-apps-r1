import { useNavigate, useSearch } from "@tanstack/react-router";
import { PermissionGate } from "../../components/ui/PermissionGate";
import { PageHeader } from "../../components/ui/PageHeader";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { BannersTab } from "./BannersTab";
import { CategoriesTab } from "./CategoriesTab";
import { PagesTab } from "./PagesTab";
import { PostsTab } from "./PostsTab";
import type { CategoryKindParam, ContentTab } from "./routes";

export { PostEditorPage } from "./PostEditorPage";

const TAB_LABEL: Record<ContentTab, string> = {
  posts: "Berita",
  banners: "Banner",
  pages: "Halaman",
  categories: "Kategori",
};

const TAB_DESCRIPTION: Record<ContentTab, string> = {
  posts: "Feed informasi untuk anggota: draf, jadwal terbit dan arsip berita.",
  banners: "Banner Beranda aplikasi: gambar, tujuan, masa tayang dan urutan.",
  pages: "Halaman informasi dan legal berversi. Draf kerja tidak terlihat publik sampai diterbitkan.",
  categories:
    "Kategori untuk berita dan event. Kategori yang dipakai tidak dapat dihapus, hanya dinonaktifkan.",
};

/**
 * Manajemen Konten (guideline p13, F-08, F-15): tab Berita | Banner | Halaman | Kategori. Tab aktif, jenis kategori
 * dan halaman yang disunting disimpan di URL (?tab=, ?kind=, ?page=) agar dapat dibagikan dan dipulihkan. Rute
 * memerlukan content.manage (AC F15-1); setiap tab juga dijaga di dalam halaman karena izin dapat dicabut saat
 * halaman terbuka (AC F16-3), dan API tetap menolak setiap permintaan tanpa izin.
 */
export function ContentPage() {
  const search = useSearch({ from: "/app/content" });
  const navigate = useNavigate({ from: "/content" });
  const tab: ContentTab = search.tab ?? "posts";

  function goTo(next: ContentTab, extra: { kind?: CategoryKindParam } = {}) {
    void navigate({ search: { tab: next, ...extra }, replace: true });
  }

  return (
    <>
      <PageHeader
        title="Manajemen Konten"
        description={TAB_DESCRIPTION[tab]}
        actions={
          <Tabs<ContentTab>
            label="Jenis konten"
            idPrefix="konten"
            value={tab}
            onValueChange={(next) => goTo(next)}
            items={(Object.keys(TAB_LABEL) as ContentTab[]).map((value) => ({
              value,
              label: TAB_LABEL[value],
            }))}
          />
        }
      />
      <TabPanel idPrefix="konten" value={tab} className="flex flex-col gap-5">
        {tab === "categories" ? (
          <PermissionGate anyOf={["content.manage", "events.manage"]}>
            <CategoriesTab
              kind={search.kind}
              onKindChange={(kind) => void navigate({ search: { tab: "categories", kind }, replace: true })}
            />
          </PermissionGate>
        ) : (
          <PermissionGate anyOf={["content.manage"]}>
            {tab === "posts" ? (
              <PostsTab onManageCategories={() => goTo("categories", { kind: "post" })} />
            ) : null}
            {tab === "banners" ? <BannersTab /> : null}
            {tab === "pages" ? (
              <PagesTab
                selectedId={search.page ?? null}
                onSelect={(page) =>
                  void navigate({ search: { tab: "pages", ...(page ? { page } : {}) }, replace: false })
                }
              />
            ) : null}
          </PermissionGate>
        )}
      </TabPanel>
    </>
  );
}
