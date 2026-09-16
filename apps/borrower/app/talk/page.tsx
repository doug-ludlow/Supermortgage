import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /app/talk — retired for now (docs/decisions/2026-09-16-apply-product.md, item 5; docs/ux/18 §2.6): the entry is the Apply
 * product on /app. The route stays as a redirect so an old link still lands somewhere; nothing links here. `components/talk`
 * stays in the tree (a later owner decision deletes it).
 */
export default function TalkPage(): never {
  redirect("/");   // Next applies basePath (/app) to a relative redirect from the app router
}
