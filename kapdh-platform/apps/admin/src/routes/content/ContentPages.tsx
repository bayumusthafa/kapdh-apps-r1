import { useNavigate, useSearch } from "@tanstack/react-router";
import { PlaceholderPage } from "../../components/layout/PlaceholderPage";
import { Card } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { UnderConstruction } from "../../components/ui/States";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import type { ContentTab } from "./routes";

const TAB_LABEL: Record<ContentTab, string> = {
  posts: "Berita",
  banners: "Banner",
  pages: "Halaman",
  categories: "Kategori",
};

const TAB_ITEMS: Record<ContentTab, string[]> = {
  posts: [
    "Draf, jadwal terbit dan arsip berita (AC F15-5)",
    "Editor teks kaya dengan sanitasi server",
    "Sampul gambar",
  ],
  banners: ["Banner beranda dengan tautan ke berita/event/halaman", "Urutan dan masa tayang"],
  pages: ["Halaman legal berversi: draf dan terbit (kebijakan privasi, ketentuan)"],
  categories: ["Kategori berita dan event"],
};

/** Placeholder area content; diganti agen halaman admin `content` (Phase C). Tab disimpan di URL (?tab=). */
export function ContentPage() {
  const search = useSearch({ from: "/app/content" });
  const navigate = useNavigate({ from: "/content" });
  const tab: ContentTab = search.tab ?? "posts";
  return (
    <>
      <PageHeader
        title="Manajemen Konten"
        description="Berita, banner, halaman dan kategori yang tampil di aplikasi KAPDH."
        actions={
          <Tabs<ContentTab>
            label="Jenis konten"
            idPrefix="konten"
            value={tab}
            onValueChange={(next) => void navigate({ search: { tab: next }, replace: true })}
            items={(Object.keys(TAB_LABEL) as ContentTab[]).map((value) => ({
              value,
              label: TAB_LABEL[value],
            }))}
          />
        }
      />
      <TabPanel idPrefix="konten" value={tab}>
        <Card>
          <UnderConstruction feature={`Pengelolaan ${TAB_LABEL[tab].toLowerCase()}`} items={TAB_ITEMS[tab]} />
        </Card>
      </TabPanel>
    </>
  );
}

export function PostEditorPage() {
  return (
    <PlaceholderPage
      title="Editor Berita"
      breadcrumbs={[{ label: "Manajemen Konten", to: "/content" }, { label: "Editor Berita" }]}
      feature="Pembuatan dan pengubahan berita"
      items={[
        "Judul, kategori, sampul dan isi",
        "Simpan draf, jadwalkan atau terbitkan",
        "Konflik versi ditangani dengan muat ulang (AC F15-4)",
      ]}
    />
  );
}
