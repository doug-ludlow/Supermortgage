import { Shell } from "@/components/Shell";
import { PipelineView } from "@/components/PipelineView";

export const dynamic = "force-dynamic";

/** 36.4: the members in motion, newest first — loan last four, masked name, stage, days in stage; each row opens the loan page. */
export default function PipelinePage() {
  return <Shell><PipelineView /></Shell>;
}
