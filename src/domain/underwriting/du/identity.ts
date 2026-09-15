/**
 * How two pulls decide they are talking about the same account, the same tradeline, the same gift — and, for the
 * EMPLOYER container, the same employer (23.5 rule 5; the Data model's `employers.identity_key`).
 *
 * Ported from Homestead-Mortgages' `model/identity.ts`. Nothing here touches the database, because the interesting
 * part is not the lookup — it is the guess. Every guess below is stated as a rule with a name, so a reader finds it
 * here rather than in production: `EMPLOYER_IDENTITY_RULES` for the employer, and the paragraphs on this header for
 * the asset and the tradeline.
 *
 * **The subject borrower opens every connector-written key.** `du_assets` and `du_liabilities` have no owner column —
 * ownership is a join table, one account with two owners being the shape the arcs exist for — so their unique index is
 * `(application_id, identity_key)` and the whole discriminating burden falls on the string. The index spans the
 * application while the key is computed from one vendor's payload about ONE person, and two borrowers are two pulls.
 * Two people holding an unmasked checking account of the same subtype at the same bank would otherwise compute one
 * key across two pulls: the second pull would update the first borrower's row while its owner arcs still pointed at the
 * first borrower, so a balance would be filed under the wrong person with nothing on the wire looking different. The
 * prefix is the `application_borrowers` row (the borrowing party on THIS application — 23.5 rule 5), not the durable
 * `parties` row Homestead used: the index is already per application, so the edge gives one person one key per
 * application, which is what a re-pull on a second file needs.
 *
 * The consequence is stated rather than discovered: a genuinely joint account reported on both borrowers' pulls becomes
 * TWO rows. That is honest — two vendor reports about one account are two pieces of evidence — but it is not what a
 * submission should carry, and collapsing the pair has a whole balance riding on it. So it is 22.4's reconciliation on
 * the way out (one row with two arcs, the other retired), never a coincidence of keys on the way in.
 *
 * **There is no ordinal in the key, at any tier.** A `#<n>` meaning "the n-th row sharing this prefix in the pull being
 * ingested" is the vendor's row order wearing another name, and under a unique index that spans retired rows the damage
 * is not a duplicate — it is a mix-up. Two unmasked accounts at one bank, the first closed between pulls: the survivor
 * takes `#1`, matches the closed account's row, overwrites its balance and its type, and keeps that row's owner arcs. A
 * joint account becomes individual and an individual one becomes joint, every label on the wire is unchanged, and a
 * byte-comparison of two submissions reports that nothing moved.
 *
 * **What the content key still cannot tell apart, said out loud.** Dropping the ordinal cures the reordering. It does not
 * cure the replacement: where the vendor masks the number and reports no opening date, a closed account and the account
 * that opened at the same bank in the same subtype after it compute ONE key, so the second pull matches the closed
 * account's row, takes its balance and its type, and keeps its owner arcs. Refusing to match cannot reach this one (that
 * rule compares the rows inside a single pull, and these two accounts are never reported together). A retired row whose
 * replacement arrives under its key is material for a reconciliation item, and no code raises one yet. The keys the
 * vendor DOES number are the way out of it, which is why tier 1 exists.
 *
 * So: tier 1 is the vendor's own stable id where the adapter exposes one, tier 2 is a content key built only from
 * properties of the row itself — so that deleting any other row cannot change it — and tier 3 is refusing to match.
 * `resolveIdentities` is tier 3: when two rows in one pull compute the same tier-2 key, that key identifies neither of
 * them, so both are written `unmatched:<this row's uuid>` and the ambiguous group is handed back for the preflight to
 * block on. A row a PERSON typed takes `manual:<uuid>`, and one migrated from the dropped `application_assets` table
 * takes `legacy:<uuid>` (db/migrations/*_du_projections.sql). Neither carries a borrower prefix and neither is produced
 * here: no re-pull can report a borrower's own typed answer, so a key that matches nothing is the honest one.
 */

import { randomUUID } from "node:crypto";

/** The prefix on a key that is deliberately unmatchable. */
export const UNMATCHED_PREFIX = "unmatched:";
/** The prefix a person's own typed row takes (23.5 tools with no vendor identity). */
export const MANUAL_PREFIX = "manual:";
/** The prefix a row migrated from the dropped `application_assets` table carries. */
export const LEGACY_PREFIX = "legacy:";

/**
 * Who reported this item, and what the reporter calls it.
 *
 * `applicationBorrowerId` is the `application_borrowers` row whose pull this is — 22.4's `verifications.borrower_id`.
 * `itemId` is the adapter's stable per-item id where it has one — Plaid's `account_id` is stable for the life of an
 * Item — so the blanket "no vendor gives us a stable identifier" inherited from income is not true of every connector.
 */
export interface VendorItem {
  readonly applicationBorrowerId: string;
  readonly provider: string;
  readonly itemId?: string | null | undefined;
}

/** The parts of an address a key is built from. */
export interface AddressFacts {
  readonly addressLineText?: string | null;
  readonly addressUnit?: string | null;
  readonly cityName?: string | null;
  readonly stateCode?: string | null;
  readonly postalCode?: string | null;
}

/**
 * What a pull reports about one asset, in the shape its key is computed from. Discriminated by the same `kind` the
 * row carries. Two of these have no column on `du_assets` — the vendor's account subtype and the opening date — which
 * is why this is its own type rather than the row. Balance is deliberately absent from all four: it is the thing a
 * re-pull is expected to change.
 */
export type AssetIdentityFacts =
  | {
      readonly kind: "DEPOSIT_ACCOUNT";
      /** The institution, as the vendor spells it. */
      readonly holderName?: string | null;
      /** The vendor's own subtype where it reports one, and nothing otherwise. */
      readonly accountSubtype?: string | null;
      /** Whatever the vendor discloses of the number; empty where it masks everything. */
      readonly accountIdentifier?: string | null;
      readonly openedOn?: Date | string | null;
    }
  | {
      readonly kind: "OTHER_ASSET";
      readonly assetType: string;
      readonly assetTypeOtherDescription?: string | null;
    }
  | {
      readonly kind: "GIFT_OR_GRANT";
      readonly assetType: string;
      readonly fundsSourceType?: string | null;
      readonly fundsSourceTypeOtherDescription?: string | null;
    }
  | {
      readonly kind: "OWNED_PROPERTY";
      readonly address: AddressFacts;
    };

/** What a credit pull reports about one tradeline. */
export interface LiabilityIdentityFacts {
  readonly holderName?: string | null;
  readonly liabilityType: string;
  readonly accountIdentifier?: string | null;
  readonly openedOn?: Date | string | null;
}

/**
 * Lowercased with every non-alphanumeric character removed — the one normalization every key here shares with the
 * employer's name key, so one bank (or one employer) punctuated two ways is one bank.
 */
export function normalized(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The last four characters the vendor disclosed, and the empty string where it disclosed none; after normalizing, so `****4455`, `xxxx-4455` and `4455` are one account. */
function lastFour(accountIdentifier: string | null | undefined): string {
  return normalized(accountIdentifier).slice(-4);
}

/** The only shape an opening date may be written in, where it is written out. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The opening date the vendor reported, as the UTC calendar day. Which day it is has to be said, because this
 * component is on no column of `du_assets`: a rule that answers differently on two machines splits an account into two
 * live rows with nothing to trace the split back to. A `Date` is read by its UTC fields on every machine; a string is
 * refused unless it is a calendar day (`06/01/2019` keyed as `06012019` and `2019-06-01` as `20190601` before — one
 * day, two keys, and no column to catch it against).
 */
function openedOnKey(openedOn: Date | string | null | undefined): string {
  if (openedOn === null || openedOn === undefined) return "";
  if (openedOn instanceof Date) {
    const year = openedOn.getUTCFullYear().toString().padStart(4, "0");
    const month = (openedOn.getUTCMonth() + 1).toString().padStart(2, "0");
    return `${year}${month}${openedOn.getUTCDate().toString().padStart(2, "0")}`;
  }
  if (!ISO_DAY.test(openedOn)) {
    throw new Error(
      `An opening date of "${openedOn}" cannot be keyed: a date the key is built from has to be a YYYY-MM-DD day or a Date, ` +
        "because two spellings of one day are two keys and the date is on no column to check them against.",
    );
  }
  return openedOn.replace(/-/g, "");
}

/** The parts normalized one at a time and joined, rather than joined and then normalized: a unit that reads as the tail of the street line is not the same property as one where the line already carried it. */
function normalizedAddress(address: AddressFacts): string {
  return [address.addressLineText, address.addressUnit, address.cityName, address.stateCode, address.postalCode].map(normalized).join(":");
}

/** Tier 1. The item id is taken verbatim — it is the vendor's string and normalizing it would merge two ids that differ only in punctuation — while the provider name is ours and is normalized. */
function vendorKey(vendor: VendorItem): string {
  return `vendor:${normalized(vendor.provider)}:${vendor.itemId}`;
}

/** Tier 2 for an asset: every component a property of this row and no other. */
function assetContentKey(facts: AssetIdentityFacts): string {
  switch (facts.kind) {
    case "DEPOSIT_ACCOUNT":
      return ["acct", normalized(facts.holderName), normalized(facts.accountSubtype), lastFour(facts.accountIdentifier), openedOnKey(facts.openedOn)].join(":");
    case "OTHER_ASSET":
      return ["other", facts.assetType, normalized(facts.assetTypeOtherDescription)].join(":");
    case "GIFT_OR_GRANT":
      return ["gift", facts.assetType, facts.fundsSourceType ?? "", normalized(facts.fundsSourceTypeOtherDescription)].join(":");
    case "OWNED_PROPERTY":
      return `reo:${normalizedAddress(facts.address)}`;
  }
}

/**
 * The key a pull writes, and the keys the row it means may already be stored under. There is one of each at most, and
 * the second exists for one movement: a provider that starts supplying item ids between two pulls. Its first pull wrote
 * a content key, its second computes a vendor key, and a matcher that knew only the second would leave the first row
 * live and write a twin beside it. So the content key comes back too, and the matcher tries it second. The movement the
 * other way (a provider that STOPS supplying an id) cannot be covered and is not.
 */
export interface IdentityKeys {
  /** What this pull writes, and what it looks the row up by first. */
  readonly key: string;
  /** Tried in order after `key`, for a row written before the vendor numbered it. */
  readonly priorKeys: readonly string[];
}

/** The subject-borrower prefix every connector-written key opens with (23.5 rule 5). */
export const subjectPrefix = (applicationBorrowerId: string): string => `p:${applicationBorrowerId}:`;

function keysFor(vendor: VendorItem, content: string): IdentityKeys {
  const contentKey = `${subjectPrefix(vendor.applicationBorrowerId)}${content}`;
  if (!vendor.itemId) return { key: contentKey, priorKeys: [] };
  return { key: `${subjectPrefix(vendor.applicationBorrowerId)}${vendorKey(vendor)}`, priorKeys: [contentKey] };
}

/** What a second bank pull recognizes an asset by: a vendor id wins where there is one; where there is none the content key is the whole answer. */
export function assetIdentityKeys(vendor: VendorItem, facts: AssetIdentityFacts): IdentityKeys {
  return keysFor(vendor, assetContentKey(facts));
}

/** The same rule for a tradeline, whose content key is the account it is on. */
export function liabilityIdentityKeys(vendor: VendorItem, facts: LiabilityIdentityFacts): IdentityKeys {
  return keysFor(vendor, ["liab", normalized(facts.holderName), facts.liabilityType, lastFour(facts.accountIdentifier), openedOnKey(facts.openedOn)].join(":"));
}

/** One row's identity, decided once the whole pull has been looked at. */
export interface ResolvedIdentity {
  /** The key to write. */
  readonly identityKey: string;
  /** The keys to look the row up by after `identityKey` finds nothing — the ones this pull's own rows do not compete for. */
  readonly priorKeys: readonly string[];
  /** The id to write the row under, when the key carries it, and null when the database is free to pick one. */
  readonly id: string | null;
  /** The tier-2 key two or more rows in this pull computed, when this row is one of them. Null when the key identifies this row on its own. */
  readonly ambiguousWith: string | null;
}

/** An ambiguous group, for whoever has to say which row is which. */
export interface AmbiguousGroup {
  readonly identityKey: string;
  readonly rowIds: readonly string[];
}

export interface IdentityPlan {
  /** One entry per item handed in, answering in the order they were handed in. */
  readonly rows: readonly ResolvedIdentity[];
  /** Empty when every key identified its row. Anything here is blocking (23.7's preflight): an ambiguous pair emitted as two independent accounts double-counts a balance. */
  readonly ambiguous: readonly AmbiguousGroup[];
  /** The prior keys two or more of this pull's rows would have fallen back to, and which none of them may therefore use. Not blocking and not silent. */
  readonly sharedPriorKeys: readonly string[];
}

/** Every string in `values` that appears more than once. */
function repeated(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(value);
    seen.add(value);
  }
  return twice;
}

/**
 * Tier 3, over one pull's keys. Position never enters a key. A key two rows share identifies neither, so both are
 * written under a fresh uuid that is also the row's own id — unmatchable by construction, including against the next
 * pull's unmatched rows. The same sentence decides the prior keys, one tier down: a key that two of this pull's rows
 * would both fall back to identifies neither of them either, so it is dropped from both, and named.
 */
export function resolveIdentities(items: readonly IdentityKeys[]): IdentityPlan {
  const shared = repeated(items.map((item) => item.key));
  // A prior key is usable only when this pull's rows do not compete for it: its own row claims it once, and nobody else claims it at all.
  const claimed = repeated(items.flatMap((item) => [...new Set([item.key, ...item.priorKeys])]));

  const groups = new Map<string, string[]>();
  const dropped = new Set<string>();
  const rows = items.map((item): ResolvedIdentity => {
    if (shared.has(item.key)) {
      const id = randomUUID();
      const group = groups.get(item.key);
      if (group) group.push(id);
      else groups.set(item.key, [id]);
      // An unmatched row matches nothing, and a fallback would be a match.
      return { identityKey: `${UNMATCHED_PREFIX}${id}`, priorKeys: [], id, ambiguousWith: item.key };
    }
    for (const prior of item.priorKeys) if (claimed.has(prior)) dropped.add(prior);
    return { identityKey: item.key, priorKeys: item.priorKeys.filter((prior) => !claimed.has(prior)), id: null, ambiguousWith: null };
  });

  return { rows, ambiguous: [...groups].map(([identityKey, rowIds]) => ({ identityKey, rowIds })), sharedPriorKeys: [...dropped] };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The employer (23.5 Data model `employers`, rule 2): Homestead's employer-identity guesses, stated as rules
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every guess Homestead's `services/employer-identity.ts` made about when two reports name one employer, by name. The
 * code below implements them; `db/migrations/*_du_graph.sql` (`employers`) holds the index and CHECKs they rely on.
 */
export const EMPLOYER_IDENTITY_RULES = {
  /** An EIN the vendor supplied is the employer's identity: `ein:<nine digits>`. Two names under one EIN are one employer; one name under two EINs is two. */
  EIN_WINS: "ein:<digits> when a vendor gave one",
  /** Without an EIN the identity is the name, normalized as every other key here is (lowercased, non-alphanumerics removed): `name:<normalized>`. */
  NAME_KEY_OTHERWISE: "name:<normalized display name> when no vendor gave an EIN",
  /** The `name:` form is ALWAYS stored on `employers.name_key`, written once, so a payroll pull that promotes the key to `ein:` and a bank pull that only knows the name find one row for one job. */
  NAME_KEY_WRITTEN_ONCE: "name_key holds the name: form on every row, whatever identity_key is",
  /** A pull matches by `identity_key` first, then by `name_key` — every pull, so a bank pull that only knows the name finds the row a payroll pull has promoted to `ein:`; an `ein:` row is never demoted to a name by a name-only pull. A pull that carries an EIN matches by name only a NAME-derived row: an `ein:` row under the same trade name but another EIN is another employer (EIN_WINS), and the pull inserts beside it. */
  MATCH_ORDER: "identity_key, then name_key (an ein: row keeps its key when a name-only pull finds it; an EIN pull matches by name only a name-derived row — one trade name under two EINs is two rows)",
  /** A name-derived row a pull recognizes by EIN is PROMOTED — its `identity_key` moves to `ein:` once, on the vendor's evidence — rather than twinned. */
  PROMOTE_ONCE: "a name-derived row found by an EIN pull takes the ein: key, once",
  /** The identity space is per borrowing party on the application (`UNIQUE (application_borrower_id, identity_key)`): a job is a borrower's; two borrowers at one employer are two rows. */
  PER_BORROWER: "unique per application_borrower_id, never per application",
  /** Merging two employer rows repoints every `application_income.employer_id` naming the loser to the survivor in the same transaction, then deletes the loser — `ON DELETE RESTRICT` makes any other order fail. */
  MERGE_REPOINTS_FIRST: "repoint every income item to the survivor, then delete the loser, in one transaction",
  /** Income items under one employer are told apart by `source_kind`; an ordinal is accepted there only as a tiebreak on a key already anchored to a matched employer row (the damage is one row's continuance judgment) — it never enters an employer key, or an asset's. */
  INCOME_ORDINAL_IS_A_TIEBREAK_ONLY: "no ordinal in an employer key; an income item's ordinal is a tiebreak under a matched employer only",
} as const;

/** EIN_WINS: the nine digits, or null when what the vendor gave is not an EIN. */
export function einDigits(ein: string | null | undefined): string | null {
  const digits = (ein ?? "").replace(/[^0-9]/g, "");
  return digits.length === 9 ? digits : null;
}

/** NAME_KEY_OTHERWISE / NAME_KEY_WRITTEN_ONCE: the `name:` form of a display name. Throws on a name that normalizes to nothing — an employer with no name has no identity and is not written. */
export function employerNameKey(displayName: string): string {
  const n = normalized(displayName);
  if (!n) throw new RangeError(`an employer named ${JSON.stringify(displayName)} has no name key; an employer with no name cannot be matched or emitted`);
  return `name:${n}`;
}

export interface EmployerIdentity {
  /** What is written to `employers.identity_key` (EIN_WINS / NAME_KEY_OTHERWISE). */
  readonly key: string;
  /** What is written to `employers.name_key` on every row (NAME_KEY_WRITTEN_ONCE). */
  readonly nameKey: string;
  readonly derivedFrom: "ein" | "name";
  /** The nine digits, when EIN_WINS applied. */
  readonly ein: string | null;
  /** MATCH_ORDER: the keys a row this pull means may already be stored under — the name key, for a pull that now carries an EIN. */
  readonly priorKeys: readonly string[];
}

/** The employer's identity under EIN_WINS, NAME_KEY_OTHERWISE, NAME_KEY_WRITTEN_ONCE and MATCH_ORDER. */
export function employerIdentityKeys(facts: { readonly displayName: string; readonly ein?: string | null | undefined }): EmployerIdentity {
  const nameKey = employerNameKey(facts.displayName);
  const ein = einDigits(facts.ein);
  if (ein) return { key: `ein:${ein}`, nameKey, derivedFrom: "ein", ein, priorKeys: [nameKey] };
  return { key: nameKey, nameKey, derivedFrom: "name", ein: null, priorKeys: [] };
}
