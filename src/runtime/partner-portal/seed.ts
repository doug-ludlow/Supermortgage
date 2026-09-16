/**
 * 36.1 Operational prerequisites — "The first partner_admin of a tenant: in non-production, seeded against the demo partner
 * beside 33.1's fixture seed (seedPartnerBookDemo; Session 1 wires it)". The sibling of src/runtime/partner-book.ts
 * seedPartnerBookDemo: the same demo partner (BORROWER_DEFAULT_PARTNER_ID / `partner_id`, else 33.1's Northlight row by legal
 * name), one `partner.user.invite` on the bus under the seed's system actor (rule 8: "the seed runs the same command with the
 * system actor" — accepted outside production only), idempotent: a tenant that already has a partner_admin row gets nothing new.
 * Wired where seedPartnerBookDemo is: `main.ts seed-demo` and `POST /v1/partner-book/seed-demo` (non-production).
 */
import { DEMO_PARTNER } from "../../domain/partner-book/fixtures/partner-book-demo.ts";
import { partnerById } from "../borrower/partner.ts";
import { partnerPartyByName } from "../partner-book.ts";
import type { Runtime } from "../app.ts";
import { PARTNER_SEED_ACTOR } from "./auth.ts";
import { PgPartnerRepository, emailHash } from "./repo.ts";

/** The demo partner_admin's address (FAKE; PARTNER_DEMO_ADMIN_EMAIL overrides it) — the door then sends its code through the FAKE port with `fake_code` echoed. */
export const DEMO_PARTNER_ADMIN_EMAIL = "partner.admin@northlight.example";
export const DEMO_PARTNER_ADMIN_NAME = "Nora Northlight";
export interface PartnerPortalSeedResult { readonly partner_party_id: string; readonly partner_user_id: string; readonly status: string; readonly roles: readonly string[]; readonly created: boolean; readonly notice_id: string | null }

export async function seedPartnerPortalDemo(runtime: Runtime, opts: { partner_id?: string; email?: string; name?: string } = {}): Promise<PartnerPortalSeedResult> {
  const configured = opts.partner_id ?? process.env["BORROWER_DEFAULT_PARTNER_ID"];
  const party = (await partnerById(runtime.db, configured)) ?? (await partnerPartyByName(runtime.db, DEMO_PARTNER.legal_name));
  if (!party) throw new RangeError(`no demo partner to seed a partner_admin against: run the partner book seed first (seedPartnerBookDemo — 33.1's parties{servicer} row for ${DEMO_PARTNER.legal_name})`);
  const email = (opts.email ?? process.env["PARTNER_DEMO_ADMIN_EMAIL"] ?? DEMO_PARTNER_ADMIN_EMAIL).trim();
  const repo = new PgPartnerRepository(runtime.db);
  const existing = await repo.userInTenant(party.id, emailHash(email));
  if (existing && existing.status !== "invited") return { partner_party_id: party.id, partner_user_id: existing.id, status: existing.status, roles: existing.roles, created: false, notice_id: null };
  if (!existing && (await repo.activeAdminsOfTenant(party.id)).length) { const admin = (await repo.usersOfTenant(party.id)).find((u) => u.status === "active" && u.roles.includes("partner_admin"))!; return { partner_party_id: party.id, partner_user_id: admin.id, status: admin.status, roles: admin.roles, created: false, notice_id: null }; }
  if (existing) return { partner_party_id: party.id, partner_user_id: existing.id, status: existing.status, roles: existing.roles, created: false, notice_id: null };   // invited already: the invitation stands; a re-invitation is the admin's or staff's act
  const r = await runtime.execute({ process: "36.1", name: "partner.user.invite", loanId: "", actor: PARTNER_SEED_ACTOR, input: { partner_party_id: party.id, email, name: opts.name ?? DEMO_PARTNER_ADMIN_NAME, roles: ["partner_admin"], rationale: "the demo partner's first partner_admin (36.1 Operational prerequisites; non-production seed)" } });
  const out = r.output as { partner_user_id: string; status: string; roles: readonly string[]; notice_id: string | null };
  runtime.logger?.info("seed-demo partner portal", { partner_party_id: party.id, partner_user_id: out.partner_user_id, status: out.status, roles: out.roles });   // never the e-mail
  return { partner_party_id: party.id, partner_user_id: out.partner_user_id, status: out.status, roles: out.roles, created: true, notice_id: out.notice_id };
}
