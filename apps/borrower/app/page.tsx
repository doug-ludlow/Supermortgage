import { Shell } from "@/components/shell/Shell";
import { FIXTURES_MODE } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Route `/` → the current conversation for the authenticated party (01 §1.5). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const fixture = typeof sp.fixture === "string" ? sp.fixture : undefined;
  const subject = typeof sp.subject === "string" ? sp.subject : undefined;
  return <Shell fixturesMode={FIXTURES_MODE} fixtureName={fixture} initialSubject={subject} />;
}
