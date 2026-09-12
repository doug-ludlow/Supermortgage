import { AccountPage } from "@/components/account/AccountPage";

export const dynamic = "force-dynamic";

/** 32.16 §2.0 (DELTA-29): /app/sign-up — the account screen in its `sign_up` mode. */
export default function SignUpPage() {
  return <AccountPage mode="sign_up" />;
}
