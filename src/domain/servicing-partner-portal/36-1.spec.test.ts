// 36.1 Partner identity, doors, roles, action log, tenant scope
// spec/sections/36-servicing-partner-portal/36-1-partner-identity-doors-roles-action-log-tenant-scope.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";

test("36.1-T1: Given a seeded partner_admin bound to the demo partner, when they request an email code and verify it plus password, then a `partner_sessions` row exists with that `partner_party_id` and role `partner_admin`, and no `staff_sessions` row is written.", { todo: true });
test("36.1-T2: Given a partner_ops session, when they `POST /v1/partner/book/imports`, then the command is refused `403 ROLE_REQUIRED`.", { todo: true });
test("36.1-T3: Given partner A’s session, when they `GET /v1/partner/book/loans/:id` for a loan whose `partner_party_id` is partner B, then the response is `404 NOT_FOUND` and a `partner_actions` row is written with `result=refused` and no homeowner PII.", { todo: true });
test("36.1-T4: Given a partner_admin, when they invite a partner_ops user, then that user can sign in and cannot upload.", { todo: true });
test("36.1-T5: Given a disabled partner_user, when they present a valid code and password, then sign-in is refused and the session is not created.", { todo: true });
test("36.1-T6: Given any successful partner GET, when the action log is read, then `partner_actions` contains `partner_portal.viewed` with `view`, `partner_user_id`, `partner_party_id`, and no email/phone/name of a homeowner.", { todo: true });
test("36.1-T7: Given a staff session cookie, when it is sent to `/v1/partner/*` or `/partners`, then the request is unauthenticated (no staff fallback).", { todo: true });
test("36.1-T8: Given a partner session, when it is sent to `/ops` or `/ops/api/*`, then the request is unauthenticated (no partner fallback).", { todo: true });
