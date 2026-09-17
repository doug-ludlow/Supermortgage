import { Shell } from "@/components/Shell";
import { BookView } from "@/components/BookView";

export const dynamic = "force-dynamic";

/** 36.2: the tape drop (partner_admin only), the last import's report, the history, the holds (read-only) and the status line. */
export default function BookPage() {
  return <Shell><BookView /></Shell>;
}
