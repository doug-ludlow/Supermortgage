/**
 * What the generator actually derived from the DU Spec, asserted against the
 * committed tables.
 *
 * These run everywhere, including on a machine with no DU_SPEC_DIR, because the
 * generated files are the committed artifact. That is the point of committing
 * them: the facts below are checkable without the licensed source, and
 * `npm run du:verify` is what ties them back to it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DU_ARCROLES, DU_RELATIONSHIP_XPATH } from "./generated/arcroles.ts";
import { DU_CARDINALITY } from "./generated/cardinality.ts";
import { DU_CONDITIONALITY, DU_CONDITION_STATEMENTS } from "./generated/conditionality.ts";
import { DU_ENUMERATIONS, LOCAL_ENUMERATIONS } from "./generated/enums.ts";
import { DU_FORMATS } from "./generated/lengths.ts";
import { CHILD_ORDER, TYPE_FOR_PATH } from "./generated/order.ts";

/**
 * Alphabetical, with EXTENSION last — the shortcut this table exists to refuse.
 * Case-insensitive, because that is the reading under which it looks most
 * plausible and gets the most types right.
 */
function alphabeticalWithExtensionLast(children: readonly string[]): string[] {
  const rest = children.filter((c) => c !== "EXTENSION");
  rest.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return children.includes("EXTENSION") ? [...rest, "EXTENSION"] : rest;
}

describe("child order", () => {
  /**
   * The nine types on the DU emission path whose sequence is not alphabetical.
   * Each is written out here in full rather than spot-checked, because "the
   * order is right" is the only thing standing between a well-formed document
   * and one Fannie Mae rejects for a reason no local check can see.
   */
  const expected: Record<string, string[]> = {
    DEAL: [
      "REFERENCE",
      "ABOUT_VERSIONS",
      "ASSETS",
      "COLLATERALS",
      "COMMUNICATION_EVENTS",
      "DEAL_DETAIL",
      "EXPENSES",
      "LIABILITIES",
      "LITIGATIONS",
      "LOANS",
      "PARTIES",
      "RELATIONSHIPS",
      "SERVICES",
      "SUPPORTING_RECORD_SETS",
      "EXTENSION",
    ],
    PARTY: [
      "REFERENCE",
      "INDIVIDUAL",
      "LEGAL_ENTITY",
      "ADDRESSES",
      "LANGUAGES",
      "ROLES",
      "TAXPAYER_IDENTIFIERS",
      "EXTENSION",
    ],
    // Thirty role containers before LICENSES, and BORROWER — the one a DU
    // file always carries — is fifth, not alphabetical among them.
    ROLE: [
      "APPRAISER",
      "APPRAISER_SUPERVISOR",
      "ATTORNEY",
      "ATTORNEY_IN_FACT",
      "BORROWER",
      "CLOSING_AGENT",
      "DEFENDANT",
      "FULFILLMENT_PARTY",
      "HOUSING_COUNSELING_AGENCY",
      "LENDER",
      "LIEN_HOLDER",
      "LOAN_ORIGINATOR",
      "LOSS_PAYEE",
      "NOTARY",
      "PAYEE",
      "PLAINTIFF",
      "PROPERTY_OWNER",
      "PROPERTY_SELLER",
      "REAL_ESTATE_AGENT",
      "REGULATORY_AGENCY",
      "REQUESTING_PARTY",
      "RESPONDING_PARTY",
      "RETURN_TO",
      "REVIEW_APPRAISER",
      "SERVICE_PROVIDER",
      "SERVICER",
      "SERVICING_TRANSFEROR",
      "SUBMITTING_PARTY",
      "TRUST",
      "TRUSTEE",
      "LICENSES",
      "PARTY_ROLE_IDENTIFIERS",
      "ROLE_DETAIL",
      "EXTENSION",
    ],
    EMPLOYER: [
      "INDIVIDUAL",
      "LEGAL_ENTITY",
      "ADDRESS",
      "CREDIT_COMMENTS",
      "EMPLOYMENT",
      "EMPLOYMENT_DOCUMENTATIONS",
      "VERIFICATION",
      "EXTENSION",
    ],
    COLLATERAL: ["PLEDGED_ASSET", "SUBJECT_PROPERTY", "COLLATERAL_DETAIL", "EXTENSION"],
    CONTACT_POINT: [
      "CONTACT_POINT_EMAIL",
      "CONTACT_POINT_SOCIAL_MEDIA",
      "CONTACT_POINT_TELEPHONE",
      "OTHER_CONTACT_POINT",
      "CONTACT_POINT_DETAIL",
      "EXTENSION",
    ],
    LICENSE: ["APPRAISER_LICENSE", "PROPERTY_LICENSE", "LICENSE_DETAIL", "EXTENSION"],
    // All data points, and the schema puts the FHA_VA prefix after the FHA
    // one — which a case-insensitive sort does not.
    GOVERNMENT_BORROWER: [
      "CAIVRSIdentifier",
      "FHABorrowerCertificationLeadPaintIndicator",
      "FHABorrowerCertificationOriginalMortgageAmount",
      "FHABorrowerCertificationOwnFourOrMoreDwellingsIndicator",
      "FHABorrowerCertificationOwnOtherPropertyIndicator",
      "FHABorrowerCertificationPropertySoldCityName",
      "FHABorrowerCertificationPropertySoldPostalCode",
      "FHABorrowerCertificationPropertySoldStateName",
      "FHABorrowerCertificationPropertySoldStreetAddressLineText",
      "FHABorrowerCertificationPropertyToBeSoldIndicator",
      "FHABorrowerCertificationRentalIndicator",
      "FHABorrowerCertificationSalesPriceAmount",
      "FHA_VABorrowerCertificationSalesPriceExceedsAppraisedValueType",
      "VABorrowerCertificationOccupancyType",
      "VABorrowerSurvivingSpouseIndicator",
      "VACoBorrowerNonTaxableIncomeAmount",
      "VACoBorrowerTaxableIncomeAmount",
      "VAFederalTaxAmount",
      "VALocalTaxAmount",
      "VAPrimaryBorrowerNonTaxableIncomeAmount",
      "VAPrimaryBorrowerTaxableIncomeAmount",
      "VASocialSecurityTaxAmount",
      "VAStateTaxAmount",
      "VeteranStatusIndicator",
      "EXTENSION",
    ],
    DOCUMENT_SPECIFIC_DATA_SET: [
      "ASSIGNMENT",
      "GFE",
      "HUD1",
      "INTEGRATED_DISCLOSURE",
      "NOTE",
      "NOTICE_OF_RIGHT_TO_CANCEL",
      "SECURITY_INSTRUMENT",
      "TIL_DISCLOSURE",
      "URLA",
      "DOCUMENT_CLASSES",
      "EXECUTION",
      "RECORDING_ENDORSEMENTS",
      "EXTENSION",
    ],
  };

  it("covers all nine of them", () => {
    // The count is part of the claim above it. A tenth type found to be
    // non-alphabetical, or one quietly dropped from the list, is the same
    // silence either way.
    assert.equal(Object.keys(expected).length, 9);
  });

  for (const [type, children] of Object.entries(expected)) {
    it(`${type} is in schema order`, () => {
      assert.deepEqual(CHILD_ORDER[type], children);
    });
  }

  for (const type of Object.keys(expected)) {
    it(`${type} is not what sorting would give`, () => {
      const children = CHILD_ORDER[type];
      assert.ok(children, `${type} is in CHILD_ORDER`);
      assert.notDeepEqual(alphabeticalWithExtensionLast(children), children);
    });
  }

  it("resolves every container XPath the spec names to a type it knows", () => {
    for (const [xpath, type] of Object.entries(TYPE_FOR_PATH)) {
      assert.ok(xpath.startsWith("MESSAGE"), xpath);
      assert.ok(Object.hasOwn(CHILD_ORDER, type), `${xpath} -> ${type}`);
    }
  });
});

describe("enumerations", () => {
  it("derives DuAssetType to 22 members", () => {
    // Twenty-three rows in the tab, one of them a repeated "Other".
    const assetType = DU_ENUMERATIONS.DuAssetType ?? [];
    assert.equal(assetType.length, 22);
    assert.ok(assetType.includes("CheckingAccount"));
    // Schema-legal and DU-illegal: in the XSD's AssetType, not in DU's subset.
    assert.ok(!assetType.includes("RealEstateOwned"));
    assert.ok(!assetType.includes("Automobile"));
  });

  it("carries both answers to both declaration questions", () => {
    // Read verbatim the tab gives IntentToOccupyType only "No".
    assert.deepEqual(DU_ENUMERATIONS.DuYesNo, ["No", "Yes"]);
  });

  it("keeps the two property-usage enums apart", () => {
    // 3a.5 carries Other and the current-usage list does not, so merging these
    // two back together would widen one of them.
    assert.ok(DU_ENUMERATIONS.DuIntendedPropertyUsage?.includes("Other"));
    assert.ok(!DU_ENUMERATIONS.DuPropertyUsage?.includes("Other"));
  });

  it("treats AssetTypeOtherDescription as the enumeration it is", () => {
    assert.deepEqual(DU_ENUMERATIONS.DuAssetTypeOtherDescription, [
      "OtherLiquidAsset",
      "OtherNonLiquidAsset",
    ]);
  });

  it("declares the one enum that is ours and gives it no members", () => {
    assert.deepEqual(LOCAL_ENUMERATIONS, ["DuAssetKind"]);
    assert.equal(DU_ENUMERATIONS.DuAssetKind, undefined);
  });

  it("derives a non-empty member list for every enum that is not ours", () => {
    for (const [name, values] of Object.entries(DU_ENUMERATIONS)) {
      assert.match(name, /^Du[A-Z]/);
      assert.ok(values.length > 0, name);
      assert.equal(new Set(values).size, values.length, name);
      for (const value of values) assert.doesNotMatch(value, /\*/, name);
    }
  });
});

describe("formats", () => {
  it("keeps a data point's width per destination", () => {
    const subject =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS" +
      "#AddressLineText#4a.3.1";
    const owned =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS" +
      "#AddressLineText#3a.2.1";
    assert.deepEqual(DU_FORMATS[subject], { kind: "string", maxLength: 50 });
    assert.deepEqual(DU_FORMATS[owned], { kind: "string", maxLength: 35 });
  });

  it("carries the full nine digits for the taxpayer identifier", () => {
    // Numeric 9, no dashes. The serializer is where the vault gets
    // dereferenced, and this is the width it has to render into.
    const key =
      "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY/TAXPAYER_IDENTIFIERS/" +
      "TAXPAYER_IDENTIFIER#TaxpayerIdentifierValue#1a.3";
    assert.deepEqual(DU_FORMATS[key], { kind: "numeric", digits: 9 });
  });
});

describe("cardinality", () => {
  it("covers the container XPaths the Cardinality tab names", () => {
    assert.equal(Object.keys(DU_CARDINALITY).length, 171);
  });

  /**
   * The borrower's own words have nowhere to go on the wire, and that is a
   * fact about DU rather than a decision this repo made. MISMO carries a
   * DECLARATION_EXPLANATIONS container -- CHILD_ORDER has it -- and DU's
   * cardinality table does not, so nothing on the emission path can hold an
   * explanation. `du_declarations.explanations` is stored for the 1003, the
   * underwriter and the file's own record, and a serializer that found the
   * container in the child order and filled it would be inventing a
   * destination rather than finding one.
   */
  it("has nowhere to put a declaration explanation", () => {
    assert.ok(CHILD_ORDER["DECLARATION"]?.includes("DECLARATION_EXPLANATIONS"));

    const paths = Object.keys(DU_CARDINALITY);
    assert.ok(paths.some((p) => p.endsWith("/BORROWER/DECLARATION")));
    assert.deepEqual(
      paths.filter((p) => /EXPLANATION/i.test(p)),
      [],
    );
  });

  it("reads MIN:MAX per product", () => {
    assert.deepEqual(DU_CARDINALITY["MESSAGE/DEAL_SETS/DEAL_SET"]?.du, { min: 1, max: 1 });
  });
});

describe("conditionality", () => {
  it("parses every statement the map carries", () => {
    const referenced = new Set<string>();
    for (const entry of DU_CONDITIONALITY) if (entry.condition !== null) referenced.add(entry.condition);
    for (const statement of referenced) {
      assert.notEqual(DU_CONDITION_STATEMENTS[statement], undefined, statement);
    }
    assert.equal(Object.keys(DU_CONDITION_STATEMENTS).length, referenced.size);
  });

  it("gives a condition to conditional rows and to no others", () => {
    for (const entry of DU_CONDITIONALITY) {
      if (entry.requirement === "conditional") assert.notEqual(entry.condition, null, entry.name);
      else assert.equal(entry.condition, null, entry.name);
    }
  });
});

describe("the relationship graph", () => {
  /**
   * Eleven arcs, and the number is worth pinning because the tab makes it easy
   * to get wrong. It describes every arc twice — once in its endpoints section
   * and once as a RELATIONSHIP block — across 82 rows of headers, sub-headings
   * and blank separators, so no count of its rows is a count of its arcs. Both
   * 82 and 23 have been quoted as the arc count.
   */
  it("holds the eleven arcs the tab describes", () => {
    assert.equal(Object.keys(DU_ARCROLES).length, 11);
    for (const [name, arc] of Object.entries(DU_ARCROLES)) {
      assert.equal(arc.name, name);
      assert.equal(arc.arcrole, `urn:fdc:mismo.org:2009:residential/${name}`);
    }
  });

  /**
   * Nine of the eleven. The two nobody has seen sent are the two that compute
   * an income figure -- rental against an owned property, employment against an
   * employer -- and they are also the two whose endpoints the tab contradicts
   * itself about. An emitter reaching for either has no shipped example to
   * copy, and that is the fact this column exists to carry.
   */
  it("says which arcs the eighteen shipped samples actually carry", () => {
    const exercised = Object.values(DU_ARCROLES)
      .filter((arc) => arc.exercised)
      .map((arc) => arc.name);
    assert.equal(exercised.length, 9);
    assert.deepEqual(
      Object.values(DU_ARCROLES)
        .filter((arc) => !arc.exercised)
        .map((arc) => arc.name),
      [
        "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET",
        "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER",
      ],
    );
  });

  /**
   * The trap, written out. At these two ends the tab names one element in its
   * endpoint XPath and Source/Target column and a different one in its `to` row
   * and in the arcrole URI, and no reading of the tab reconciles them. The
   * generated table carries all four names rather than picking, because an
   * emitter that arced to the wrong element would produce a document `xmllint`
   * accepts and DU rejects days later.
   */
  it("keeps both readings of the two ends the tab contradicts itself about", () => {
    const rentalIncome = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET"]!.to;
    assert.equal(rentalIncome.disputed, true);
    assert.equal(rentalIncome.xpath, "DEAL/ASSETS/ASSET/OWNED_PROPERTY/OWNED_PROPERTY_DETAIL");
    assert.equal(rentalIncome.container, "OWNED_PROPERTY_DETAIL");
    assert.equal(rentalIncome.relationshipEnd, "ASSET");
    assert.equal(rentalIncome.arcroleTerm, "ASSET");

    const employmentIncome = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER"]!.to;
    assert.equal(employmentIncome.disputed, true);
    assert.equal(employmentIncome.xpath, "DEAL/PARTIES/PARTY/ROLES/ROLE/BORROWER/EMPLOYERS/EMPLOYER");
    assert.equal(employmentIncome.container, "EMPLOYMENT");
    assert.equal(employmentIncome.relationshipEnd, "EMPLOYMENT");
    assert.equal(employmentIncome.arcroleTerm, "EMPLOYER");
  });

  it("disputes no other end", () => {
    const disputed: string[] = [];
    for (const arc of Object.values(DU_ARCROLES)) {
      if (arc.from.disputed) disputed.push(`${arc.name} from`);
      if (arc.to.disputed) disputed.push(`${arc.name} to`);
    }
    assert.deepEqual(disputed, [
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET to",
      "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER to",
    ]);
  });

  /**
   * All eleven arcs live in one container, and it is the one container on the
   * emission path that the other four tables say nothing about: DEAL declares
   * RELATIONSHIPS as a child, and no XPath in the DU Map or the Cardinality tab
   * reaches inside it. So the arc table is not a convenience over those — it is
   * the only description of the graph the code has, which is why a serializer
   * that only read `CHILD_ORDER` and `DU_CARDINALITY` would emit a document
   * with no arcs at all and no local symptom.
   */
  it("describes the one container the other generated tables do not reach", () => {
    assert.equal(DU_RELATIONSHIP_XPATH, "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS/RELATIONSHIP");
    assert.ok(CHILD_ORDER["DEAL"]?.includes("RELATIONSHIPS"));
    assert.deepEqual(
      Object.keys(TYPE_FOR_PATH).filter((p) => /RELATIONSHIP/.test(p)),
      [],
    );
    assert.deepEqual(
      Object.keys(DU_CARDINALITY).filter((p) => /RELATIONSHIP/.test(p)),
      [],
    );
  });
});
