import { AccountPage } from "@/components/account/AccountPage";

export const dynamic = "force-dynamic";

/** 32.16 §2.0 (DELTA-29): /app/reset — the account screen in its `reset` mode. */
export default function ResetPage() {
  return <AccountPage mode="reset" />;
}
