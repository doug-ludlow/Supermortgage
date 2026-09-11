import { notFound } from "next/navigation";
import { EntryPreview } from "@/components/entry/EntryPreview";
import { SHOW_FAKE_MARKERS } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * FAKE, dev/fixtures only: /app/entry-preview renders the 32.14 anonymous minute (S0–S2) in the shell's
 * chrome so tests/e2e/entry.spec.ts can drive it with `page.route` canned lead responses before the
 * shell integration lands. A production build (SHOW_FAKE_MARKERS false) answers 404.
 */
export default function Page() {
  if (!SHOW_FAKE_MARKERS) notFound();
  return <EntryPreview />;
}
