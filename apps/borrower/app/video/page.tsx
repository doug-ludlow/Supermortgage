import { VideoShell } from "@/components/video/VideoShell";
import { FIXTURES_MODE } from "@/lib/env";

export const dynamic = "force-dynamic";

/** 32.17 — /app/video: the same conversation, face to face, with the cards on the rail. The account door (32.16 §2.0) stands in front of it. */
export default async function VideoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const fixture = typeof sp.fixture === "string" ? sp.fixture : undefined;
  const subject = typeof sp.subject === "string" ? sp.subject : undefined;
  return <VideoShell fixturesMode={FIXTURES_MODE} fixtureName={fixture} initialSubject={subject} />;
}
