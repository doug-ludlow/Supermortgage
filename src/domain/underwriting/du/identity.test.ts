/**
 * The key itself, with no database in the way (port of Homestead-Mortgages' model/identity.test.ts to node:test).
 *
 * Everything a re-pull does rests on this string, so the properties worth asserting are the ones that are invisible
 * in a passing ingest: that the subject borrower opens every connector-written key, that nothing about where a row sat
 * in the vendor's list reaches it, and that two rows a vendor cannot tell apart are refused a match rather than given
 * one by arrival order. Two more are here because they are invisible in a passing TEST: a key is also a lookup, so a
 * pull carries the key it would have written before the vendor numbered its accounts — and a component computed from
 * a clock answers differently on two machines, which is a split no row records. The last group is the employer, whose
 * guesses are named rules (EMPLOYER_IDENTITY_RULES) rather than comments.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assetIdentityKeys, liabilityIdentityKeys, resolveIdentities, employerIdentityKeys, employerNameKey, einDigits, EMPLOYER_IDENTITY_RULES,
  type AssetIdentityFacts, type LiabilityIdentityFacts, type VendorItem,
} from "./identity.ts";

const PRIYA = "11111111-1111-4111-8111-111111111111";
const DEV = "22222222-2222-4222-8222-222222222222";

const bank: VendorItem = { applicationBorrowerId: PRIYA, provider: "plaid" };

/** The key a pull writes, for the assertions that are only about the string. What the pull would ALSO look the row up by is its own describe below. */
const keyOf = (vendor: VendorItem, facts: AssetIdentityFacts): string => assetIdentityKeys(vendor, facts).key;
const liabilityKeyOf = (vendor: VendorItem, facts: LiabilityIdentityFacts): string => liabilityIdentityKeys(vendor, facts).key;

const checking: AssetIdentityFacts = { kind: "DEPOSIT_ACCOUNT", holderName: "First Federal", accountSubtype: "checking", accountIdentifier: "****4455" };

describe("the subject borrower opens a connector-written key", () => {
  test("is the whole difference between two borrowers' identical accounts", () => {
    // The index is (application_id, identity_key) and one application holds both borrowers, so without this prefix
    // these two are one key — and the second pull would update the first borrower's row while its owner arcs still
    // pointed at the first borrower.
    const hers = keyOf(bank, checking);
    const his = keyOf({ ...bank, applicationBorrowerId: DEV }, checking);
    assert.notEqual(hers, his);
    assert.equal(hers.replace(PRIYA, ""), his.replace(DEV, ""));
    assert.equal(hers.startsWith(`p:${PRIYA}:`), true);
  });
});

describe("tier 1, where the adapter has a stable id", () => {
  test("is the id and nothing else, so a changed mask keeps the row", () => {
    const withMask = keyOf({ ...bank, itemId: "acc_9f2" }, checking);
    const maskChanged = keyOf({ ...bank, itemId: "acc_9f2" }, { ...checking, accountIdentifier: "1199", accountSubtype: "savings" });
    assert.equal(withMask, maskChanged);
    assert.equal(withMask, `p:${PRIYA}:vendor:plaid:acc_9f2`);
  });
  test("keeps the vendor's id verbatim and normalizes only the provider name", () => {
    // Two ids differing in punctuation are two accounts; lowercasing them would merge a pair the vendor is telling us apart.
    const upper = keyOf({ ...bank, itemId: "ACC_9F2" }, checking);
    const lower = keyOf({ ...bank, itemId: "acc_9f2" }, checking);
    assert.notEqual(upper, lower);
    assert.equal(keyOf({ ...bank, provider: "Plaid", itemId: "x" }, checking), keyOf({ ...bank, provider: "plaid", itemId: "x" }, checking));
  });
});

describe("tier 2, the content key", () => {
  test("ignores the balance, which is the thing a re-pull is expected to change", () => {
    // Balance has no place in the facts at all, which is the strongest form of this: a caller cannot put it there by accident.
    assert.equal(keyOf(bank, checking), `p:${PRIYA}:acct:firstfederal:checking:4455:`);
  });
  test("reads one bank spelled two ways as one bank, and one mask masked two ways as one account", () => {
    assert.equal(keyOf(bank, { ...checking, holderName: "first federal!" }), keyOf(bank, checking));
    assert.equal(keyOf(bank, { ...checking, accountIdentifier: "xxxx-4455" }), keyOf(bank, checking));
  });
  test("tells two accounts at one bank apart by subtype, and by the day one opened", () => {
    const savings = keyOf(bank, { ...checking, accountSubtype: "savings" });
    assert.notEqual(savings, keyOf(bank, checking));
    const opened = keyOf(bank, { ...checking, openedOn: "2019-06-01" });
    assert.equal(opened, `p:${PRIYA}:acct:firstfederal:checking:4455:20190601`);
    assert.equal(keyOf(bank, { ...checking, openedOn: new Date("2019-06-01T00:00:00Z") }), opened);
  });
  test("gives a gift a key its sibling gift cannot take", () => {
    // Two sets of parents, two gifts, and an earlier rule keyed on type and source alone made the second one unwritable.
    const fromHers = keyOf(bank, { kind: "GIFT_OR_GRANT", assetType: "GiftOfCash", fundsSourceType: "Parent", fundsSourceTypeOtherDescription: "Priya's parents" });
    const fromHis = keyOf(bank, { kind: "GIFT_OR_GRANT", assetType: "GiftOfCash", fundsSourceType: "Parent", fundsSourceTypeOtherDescription: "Dev's parents" });
    assert.notEqual(fromHers, fromHis);
  });
  test("keys an other asset on its description and an owned property on its address", () => {
    assert.equal(keyOf(bank, { kind: "OTHER_ASSET", assetType: "Other", assetTypeOtherDescription: "OtherNonLiquidAsset" }), `p:${PRIYA}:other:Other:othernonliquidasset`);
    assert.equal(keyOf(bank, { kind: "OWNED_PROPERTY", address: { addressLineText: "88 Foster Lane", cityName: "Austin", stateCode: "TX", postalCode: "78745" } }), `p:${PRIYA}:reo:88fosterlane::austin:tx:78745`);
  });
  test("keys a tradeline the same way, on the account rather than the balance", () => {
    const card = { holderName: "Shoreline CU", liabilityType: "Revolving", accountIdentifier: "0027" } as const;
    assert.equal(liabilityKeyOf(bank, card), `p:${PRIYA}:liab:shorelinecu:Revolving:0027:`);
    // The same account reported as a different kind of debt is a different tradeline, not the same one revalued.
    assert.notEqual(liabilityKeyOf(bank, { ...card, liabilityType: "Installment" }), liabilityKeyOf(bank, card));
  });
});

describe("there is no ordinal, at any tier", () => {
  test("gives the same account the same key wherever the vendor puts it in the list", () => {
    // The property an ordinal breaks. With a `#<n>` on the key, dropping the first of three accounts moves every survivor's key onto the row above it.
    const pull: AssetIdentityFacts[] = [{ ...checking, accountSubtype: "checking" }, { ...checking, accountSubtype: "savings" }, { ...checking, accountSubtype: "money market" }];
    const first = pull.map((facts) => keyOf(bank, facts));
    const reordered = [pull[2]!, pull[0]!, pull[1]!].map((facts) => keyOf(bank, facts));
    assert.deepEqual([...first].sort(), [...reordered].sort());
    assert.equal(keyOf(bank, pull[1]!), reordered[2]);
  });
  test("does not consult the rest of the pull, so a sibling disappearing changes nothing", () => {
    const alone = keyOf(bank, checking);
    const amongOthers = [checking, { ...checking, accountSubtype: "savings" }].map((facts) => keyOf(bank, facts));
    assert.equal(amongOthers[0], alone);
  });
});

describe("tier 3 refuses to match", () => {
  const twin = () => assetIdentityKeys(bank, checking);
  const savings = () => assetIdentityKeys(bank, { ...checking, accountSubtype: "savings" });

  test("writes both ambiguous rows unmatched and names the group", () => {
    const key = keyOf(bank, checking);
    const plan = resolveIdentities([twin(), savings(), twin()]);
    assert.deepEqual(plan.rows[1], { identityKey: savings().key, priorKeys: [], id: null, ambiguousWith: null });
    for (const row of [plan.rows[0]!, plan.rows[2]!]) {
      assert.equal(row.ambiguousWith, key);
      assert.equal(row.identityKey, `unmatched:${row.id}`);
    }
    assert.deepEqual(plan.ambiguous, [{ identityKey: key, rowIds: [plan.rows[0]!.id, plan.rows[2]!.id] }]);
  });
  test("gives the next pull's ambiguous rows uuids of their own", () => {
    // Which is what makes the cost bearable: the old rows stay live beside the new ones until somebody says which is which, and nothing collides while they wait.
    const first = resolveIdentities([twin(), twin()]);
    const second = resolveIdentities([twin(), twin()]);
    const keys = [...first.rows, ...second.rows].map((row) => row.identityKey);
    assert.equal(new Set(keys).size, 4);
  });
  test("says nothing is ambiguous when every key identifies its row", () => {
    const plan = resolveIdentities([twin(), savings()]);
    assert.deepEqual(plan.ambiguous, []);
    assert.deepEqual(plan.sharedPriorKeys, []);
    assert.equal(plan.rows.every((row) => row.id === null && row.ambiguousWith === null), true);
  });
});

describe("the key the row may already be stored under", () => {
  test("is the content key, for a pull the vendor has started numbering", () => {
    // A provider that supplies ids on its second pull computes a key no existing row carries. Without the fallback the row it means stays live and a twin is written beside it, so the balance is counted twice.
    const numbered = assetIdentityKeys({ ...bank, itemId: "acc_9f2" }, checking);
    assert.equal(numbered.key, `p:${PRIYA}:vendor:plaid:acc_9f2`);
    assert.deepEqual(numbered.priorKeys, [keyOf(bank, checking)]);
  });
  test("is nothing at all where the content key is what gets written", () => {
    // There is no second thing to try: a row that was never numbered was written under exactly this string.
    assert.deepEqual(assetIdentityKeys(bank, checking).priorKeys, []);
    assert.deepEqual(liabilityIdentityKeys({ ...bank, itemId: "tl_1" }, { holderName: "Shoreline CU", liabilityType: "Revolving", accountIdentifier: "0027" }).priorKeys, [`p:${PRIYA}:liab:shorelinecu:Revolving:0027:`]);
  });
  test("is dropped when two of one pull's rows would both fall back to it", () => {
    // Two content-identical accounts the bank has just begun numbering. Each identifies itself, so neither is unmatched — but following the fallback would land both on the one row already filed under it, the second overwriting the first, which loses a balance rather than duplicating one.
    const one = assetIdentityKeys({ ...bank, itemId: "acc_1" }, checking);
    const two = assetIdentityKeys({ ...bank, itemId: "acc_2" }, checking);
    const plan = resolveIdentities([one, two]);
    assert.deepEqual(plan.rows.map((row) => row.identityKey), [one.key, two.key]);
    assert.deepEqual(plan.rows.map((row) => row.priorKeys), [[], []]);
    assert.deepEqual(plan.ambiguous, []);
    assert.deepEqual(plan.sharedPriorKeys, [keyOf(bank, checking)]);
  });
  test("is dropped when another row in the pull is being written under it", () => {
    // The numbered account would otherwise take the row the unnumbered one is writing, inside one transaction.
    const numbered = assetIdentityKeys({ ...bank, itemId: "acc_1" }, checking);
    const plan = resolveIdentities([numbered, assetIdentityKeys(bank, checking)]);
    assert.deepEqual(plan.rows[0]!.priorKeys, []);
    assert.equal(plan.rows[1]!.identityKey, keyOf(bank, checking));
    assert.deepEqual(plan.sharedPriorKeys, [keyOf(bank, checking)]);
  });
});

describe("an opening date is a day, and the same day everywhere", () => {
  test("reads a Date as its UTC day rather than the machine's", () => {
    // Two instants half an hour either side of a UTC midnight, so a rule reading the machine's own calendar fields answers wrongly on every timezone that is not Greenwich itself, whichever side of it it sits.
    assert.equal(keyOf(bank, { ...checking, openedOn: new Date("2019-06-01T23:30:00Z") }), `p:${PRIYA}:acct:firstfederal:checking:4455:20190601`);
    assert.equal(keyOf(bank, { ...checking, openedOn: new Date("2019-06-02T00:30:00Z") }), `p:${PRIYA}:acct:firstfederal:checking:4455:20190602`);
    assert.equal(keyOf(bank, { ...checking, openedOn: new Date(Date.UTC(2019, 5, 1)) }), keyOf(bank, { ...checking, openedOn: "2019-06-01" }));
  });
  test("refuses a date written any other way, rather than keying its punctuation", () => {
    // `06/01/2019` used to key as `06012019` and `2019-06-01` as `20190601`: one day, two keys, two rows, and no way to tell from either row.
    assert.throws(() => keyOf(bank, { ...checking, openedOn: "06/01/2019" }), /cannot be keyed/);
    assert.throws(() => keyOf(bank, { ...checking, openedOn: "2019-06-01T00:00:00Z" }), /cannot be keyed/);
  });
});

describe("the employer's identity is a named rule, not a comment", () => {
  test("EIN_WINS: an EIN is the key and the name key is what the row may already be filed under", () => {
    const k = employerIdentityKeys({ displayName: "Acme Manufacturing, Inc.", ein: "12-3456789" });
    assert.deepEqual(k, { key: "ein:123456789", nameKey: "name:acmemanufacturinginc", derivedFrom: "ein", ein: "123456789", priorKeys: ["name:acmemanufacturinginc"] });
    assert.equal(einDigits("12-3456789"), "123456789");
    assert.equal(einDigits("1234"), null, "eight digits is not an EIN and does not become a key");
  });
  test("NAME_KEY_OTHERWISE / NAME_KEY_WRITTEN_ONCE: one employer punctuated two ways is one key, and the name key is on every row", () => {
    const a = employerIdentityKeys({ displayName: "Acme Manufacturing (FAKE payroll)" });
    const b = employerIdentityKeys({ displayName: "acme manufacturing - fake payroll" });
    assert.equal(a.key, b.key); assert.equal(a.key, "name:acmemanufacturingfakepayroll"); assert.equal(a.derivedFrom, "name"); assert.deepEqual(a.priorKeys, []);
    assert.equal(a.nameKey, employerNameKey("Acme Manufacturing (FAKE payroll)"));
    assert.equal(employerIdentityKeys({ displayName: "Acme", ein: "123456789" }).nameKey, "name:acme");
  });
  test("an employer with no name has no identity", () => {
    assert.throws(() => employerNameKey("  --- "), /no name key/);
  });
  test("the rules are stated once, by name", () => {
    assert.deepEqual(Object.keys(EMPLOYER_IDENTITY_RULES).sort(), ["EIN_WINS", "INCOME_ORDINAL_IS_A_TIEBREAK_ONLY", "MATCH_ORDER", "MERGE_REPOINTS_FIRST", "NAME_KEY_OTHERWISE", "NAME_KEY_WRITTEN_ONCE", "PER_BORROWER", "PROMOTE_ONCE"]);
  });
});
