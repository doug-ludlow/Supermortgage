import { Shell } from "@/components/Shell";
import { HomeView } from "@/components/HomeView";

export const dynamic = "force-dynamic";

/** 36.5 rule 1: Home — the tape as-of and next due, the late badge, the three bucket counts, the in-flight count, the latest daily report. */
export default function HomePage() {
  return <Shell><HomeView /></Shell>;
}
