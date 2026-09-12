import { Disclosures } from "@/components/shell/Disclosures";

export const dynamic = "force-dynamic";

/** 32.16 §1 principle 8: /app/disclosures — the footer's "Disclosures and licenses" link: the lender's name, NMLS ID and state licenses. */
export default function DisclosuresPage() {
  return <Disclosures />;
}
