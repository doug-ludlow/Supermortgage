import { Shell } from "@/components/Shell";
import { AdminView } from "@/components/AdminView";

export const dynamic = "force-dynamic";

/** 36.1 rule 8: the Admin area — partner_admin only: the tenant's users, the invitation; a disable is DELTA-01 (no command in V1). */
export default function AdminPage() {
  return <Shell><AdminView /></Shell>;
}
