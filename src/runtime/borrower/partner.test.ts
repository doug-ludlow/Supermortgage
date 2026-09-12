/**
 * partner.ts — the entry partner is never Supermortgage itself (docs/ux/17 §2.0; 32.14 DELTA-15): the configured party
 * when set, else the newest servicer party that is not Supermortgage, else null; a configured id that names Supermortgage
 * or nothing is refused, not guessed.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { connect } from "../../infra/db/client.ts";
import { entryPartner, partnerById } from "./partner.ts";

const url = process.env["DATABASE_URL"]; const skip = url ? false : "DATABASE_URL unset";
const db = url ? connect(url) : null;
const R = randomUUID().slice(0, 8);
const made: string[] = [];
const party = async (name: string): Promise<string> => { const r = (await db!.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, $2, '1000123') RETURNING id`, [name, String(100000000 + Math.floor(Math.random() * 899999999))]))[0]!.id; made.push(r); return r; };

before(async () => { if (skip) return; await db!.query(`SELECT 1`); });
after(async () => { if (skip) return; await db!.query(`DELETE FROM parties WHERE id = ANY($1::uuid[])`, [made]); await db!.end(); });

test("the newest servicer party that is not Supermortgage; the batch's own party is skipped even when it is newest", { skip }, async () => {
  const partner = await party(`Partner Bank ${R}`);
  await new Promise((r) => setTimeout(r, 5));
  const own = await party("Supermortgage");
  const got = await entryPartner(db!, undefined);
  assert.ok(got, "a partner"); assert.equal(got.id, partner, "not the Supermortgage party"); assert.equal(got.legal_name, `Partner Bank ${R}`);
  assert.equal(await partnerById(db!, own), null, "Supermortgage by id is refused too");
  assert.equal((await entryPartner(db!, own)), null, "configured to Supermortgage: refused, not the fallback");
});

test("the configured party wins; a configured id that names no party is refused rather than guessed", { skip }, async () => {
  const configured = await party(`Configured Bank ${R}`);
  await new Promise((r) => setTimeout(r, 5));
  await party(`Newer Bank ${R}`);
  assert.equal((await entryPartner(db!, configured))?.id, configured);
  assert.equal(await entryPartner(db!, randomUUID()), null);
  assert.equal(await entryPartner(db!, "not-a-uuid"), null);
});
