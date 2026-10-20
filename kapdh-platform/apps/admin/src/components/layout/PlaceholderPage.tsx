import type { ReactNode } from "react";
import { Card } from "../ui/Card";
import { type Breadcrumb, PageHeader } from "../ui/PageHeader";
import { UnderConstruction } from "../ui/States";

/**
 * Halaman area yang rutenya, izinnya dan menunya sudah terdaftar sejak fondasi tetapi isinya dibangun irisan
 * halaman admin Phase C (BUILD_PLAN). Pemilik area mengganti komponen ini di src/routes/<area>/.
 */
export function PlaceholderPage({
  title,
  description,
  breadcrumbs,
  feature,
  items,
  children,
}: {
  title: string;
  description?: string;
  breadcrumbs?: Breadcrumb[];
  feature: string;
  items?: string[];
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} breadcrumbs={breadcrumbs} />
      {children}
      <Card>
        <UnderConstruction feature={feature} items={items} />
      </Card>
    </>
  );
}
