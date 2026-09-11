import { Shell } from "@/components/shell/Shell";
import { FIXTURES_MODE } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Route `/` → the current conversation for the authenticated party (01 §1.5). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const fixture = typeof sp.fixture === "string" ? sp.fixture : undefined;
  const subject = typeof sp.subject === "string" ? sp.subject : undefined;
  const card = typeof sp.card === "string" ? sp.card : undefined; // 32.14 S5: a deep link or a vendor return lands with the card pinned
  return <Shell fixturesMode={FIXTURES_MODE} fixtureName={fixture} initialSubject={subject} initialCard={card} />;
}
