import { Shell } from "@/components/shell/Shell";
import { FIXTURES_MODE } from "@/lib/env";

export const dynamic = "force-dynamic";

function querySuffix(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const key of ["fixture", "subject", "card"] as const) {
    const v = sp[key];
    if (typeof v === "string" && v) q.set(key, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Route `/guide` → Guide (Michelle): thread + rail + action bar (docs/ux/18 / 17 §2). */
export default async function GuidePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const fixture = typeof sp.fixture === "string" ? sp.fixture : undefined;
  const subject = typeof sp.subject === "string" ? sp.subject : undefined;
  const card = typeof sp.card === "string" ? sp.card : undefined;
  return <Shell surface="guide" fixturesMode={FIXTURES_MODE} fixtureName={fixture} initialSubject={subject} initialCard={card} querySuffix={querySuffix(sp)} />;
}
