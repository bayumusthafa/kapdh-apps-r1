import { LoaderCircle } from "lucide-react";
import { cn } from "../../lib/cn";

/** Indikator memuat dekoratif; teks status disampaikan oleh pemanggil (mis. aria-busy atau role="status"). */
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden="true" className={cn("size-4 shrink-0 animate-spin", className)} />;
}
