/**
 * 34.1 rule 3 (amended 2026-09-15, the portal proposal §3): chooseRole's three cases — a preferred role the account holds and
 * the route accepts is the role; held but not accepted, a read falls back to the least-privileged accepted held role in
 * ROLE_ORDER (never the route's own first role) while an act is refused ROLE_REQUIRED{role, held, act_as: [the accepted roles
 * held]}; a role the account does not hold is refused on either method with act_as []. With no preference a read acts as the
 * least-privileged accepted held role, while an act is asked for under the session's default role (the least-privileged held role,
 * the one /api/me reports) and refused the same way when the route does not accept it — never run under an inferred greater one.
 * Pure functions — no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRole, actAsOffer, ROLE_ORDER, StaffError } from "./roles.ts";

const FOUR = [...ROLE_ORDER];
const refusal = (fn: () => unknown): StaffError => { try { fn(); } catch (e) { if (e instanceof StaffError) return e; throw e; } throw new Error("expected a StaffError"); };

test("chooseRole: a preferred role the account holds and the route accepts is the role, on a read and on an act alike", () => {
  assert.equal(chooseRole(FOUR, ["ops_analyst", "officer", "compliance"], "officer", { mode: "read" }), "officer");
  assert.equal(chooseRole(FOUR, ["compliance", "officer"], "compliance", { mode: "act" }), "compliance");
  assert.equal(chooseRole(FOUR, ["officer"], "officer"), "officer");
  assert.equal(chooseRole(["ops_analyst"], null, "ops_analyst"), "ops_analyst", "a route that accepts any role");
});

test("chooseRole: held but not accepted — a read acts as the least-privileged accepted held role in ROLE_ORDER (not the route's first role); an act is refused ROLE_REQUIRED{role, held, act_as}", () => {
  assert.deepEqual(ROLE_ORDER, ["ops_analyst", "officer", "compliance", "admin"]);
  assert.equal(chooseRole(FOUR, ["ops_analyst", "officer", "compliance"], "admin", { mode: "read" }), "ops_analyst");
  assert.equal(chooseRole(FOUR, ["compliance", "officer"], "admin", { mode: "read" }), "officer", "officer before compliance whatever the route's own order");
  assert.equal(chooseRole(["officer", "compliance", "admin"], ["compliance", "admin"], "officer", { mode: "read" }), "compliance");
  const e = refusal(() => chooseRole(FOUR, ["officer"], "ops_analyst", { mode: "act" }));
  assert.equal(e.status, 403); assert.equal(e.code, "ROLE_REQUIRED"); assert.deepEqual(e.extra, { role: "officer", held: FOUR, act_as: ["officer"] });
  const e2 = refusal(() => chooseRole(FOUR, ["compliance", "officer"], "admin"));   // act is the default: no substitution unless the caller says it is a read
  assert.deepEqual(e2.extra, { role: "compliance", held: FOUR, act_as: ["officer", "compliance"] }); assert.match(e2.message, /act as officer or compliance/);
  // a read with nothing to fall back to is refused the same way, act_as []
  const e3 = refusal(() => chooseRole(["admin"], ["ops_analyst", "officer", "compliance"], "admin", { mode: "read" }));
  assert.deepEqual(e3.extra, { role: "ops_analyst", held: ["admin"], act_as: [] });
});

test("chooseRole: a role the account does not hold is refused on either method with act_as []; no preference — a read acts as the least-privileged accepted held role, an act is asked for under the session's default role and refused ROLE_REQUIRED{role, held, act_as} when the route does not accept it; nothing accepted is refused", () => {
  for (const mode of ["read", "act"] as const) { const e = refusal(() => chooseRole(["ops_analyst"], ["officer"], "officer", { mode })); assert.deepEqual([e.status, e.code, e.extra], [403, "ROLE_REQUIRED", { role: "officer", held: ["ops_analyst"], act_as: [] }]); }
  assert.equal(chooseRole(FOUR, ["compliance", "officer"], null, { mode: "read" }), "officer", "a read with no preference: the least-privileged accepted held role");
  // an act with no role named runs under the session's default role — ops_analyst for these accounts, the role /api/me reports — never under an inferred greater one: the same offer as naming it
  const inferred = refusal(() => chooseRole(["ops_analyst", "officer"], ["officer"], null));
  assert.deepEqual([inferred.status, inferred.code, inferred.extra], [403, "ROLE_REQUIRED", { role: "officer", held: ["ops_analyst", "officer"], act_as: ["officer"] }]); assert.match(inferred.message, /not ops_analyst; act as officer/);
  const four = refusal(() => chooseRole(FOUR, ["compliance", "officer"], null, { mode: "act" }));
  assert.deepEqual(four.extra, { role: "compliance", held: FOUR, act_as: ["officer", "compliance"] });
  assert.equal(chooseRole(["compliance", "admin"], ["compliance", "admin"]), "compliance", "the default role is accepted: it acts");
  assert.equal(chooseRole(["officer"], null), "officer");
  assert.equal(chooseRole(["officer", "admin"], ["officer"], ""), "officer", "an empty preference is none");
  assert.equal(chooseRole(["admin", "attorney"], ["attorney"], null, { mode: "read" }), "attorney", "a read still falls back to a tool's own human role"); const own = refusal(() => chooseRole(["admin", "attorney"], ["attorney"], null)); assert.deepEqual(own.extra, { role: "attorney", held: ["admin", "attorney"], act_as: ["attorney"] });
  const none = refusal(() => chooseRole(["admin"], ["ops_analyst", "officer", "compliance"]));
  assert.deepEqual(none.extra, { role: "ops_analyst", held: ["admin"], act_as: [] });
  const empty = refusal(() => chooseRole([], null)); assert.deepEqual(empty.extra, { role: "ops_analyst", held: [], act_as: [] });
  // the offer: the staff four least-privileged first, then a tool's own human roles the account holds in the account's order
  assert.deepEqual(actAsOffer(["admin", "compliance", "officer", "attorney"], ["compliance", "officer", "attorney"]), ["officer", "compliance", "attorney"]);
  assert.deepEqual(actAsOffer(["ops_analyst"], ["officer"]), []);
});
