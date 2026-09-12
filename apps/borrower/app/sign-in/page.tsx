import { AccountPage } from "@/components/account/AccountPage";

export const dynamic = "force-dynamic";

/** 32.16 §2.0 (DELTA-29): /app/sign-in — the account screen in its `sign_in` mode. */
export default function SignInPage() {
  return <AccountPage mode="sign_in" />;
}
