/**
 * Test fixture: the refinance fixture of 23.1-T1 (spec README — worked example 1, the Riveras' $560,000 limited
 * cash-out refinance at 6.125 %, appraised $800,000, income $12,000.00, obligations $4,560.00) as a 23.5 graph the
 * emitter can assemble strictly — every DU Map required point present, nothing defaulted at emission. The purchase
 * fixture (worked example 4, the Okafor HomeReady purchase) comes out of the same function: the shape follows the
 * snapshot's `loan_purpose`. Everything the snapshot states (loan terms, values, income, obligations, the borrowers'
 * identity) is derived from it, so a snapshot that differs by one cent yields different bytes (23.6-T7, 23.1 rule 3);
 * everything it does not state (names, dates of birth, addresses, the declarations, the checking account) is the
 * fixture's own and fixed. The shapes are DI-C04's (the LCO refinance sample) and DI-C01's (the purchase sample):
 * an OWNED_PROPERTY asset for the subject with its MortgageLoan liability paid off at closing, one Base income item per
 * borrower arced to an employer, a joint checking account, the current residence, the fourteen declarations.
 *
 * Test-only: imported by src/domain/underwriting/23-1.spec.test.ts and 23-6.spec.test.ts; never by runtime.
 */
import type { DuArc, DuContainer, DuGraph, DuValue } from "../du/emit.ts";
import { withDeal } from "../du/emit.ts";
import { dealFromSnapshot, type UladSnapshot } from "../ops-23-1.ts";

export interface RefinanceFixtureOptions {
  /** `applications.du_casefile_id` — DU's own identifier, present on a resubmission (23.6 rule 8; the FAKE port mints it in 23.7). */
  readonly du_casefile_id?: string | null;
  /** The casefile's partner-org System ID (23.1 harness: SYS-PARTNER-01). */
  readonly system_id_ref?: string;
}
/** The 23.1 harness's casefile System ID. */
export const FIXTURE_SYSTEM_ID_REF = "SYS-PARTNER-01";

/** The identifier the fixture's DU minted for the casefile on submission 1 — ten digits, the shape the 23.7 FAKE mints. */
export const FIXTURE_DU_CASEFILE_ID = "1234567890";

const FIRST_NAMES: Readonly<Record<string, string>> = { B1: "Ana", B2: "Luis", B3: "Chidi" };
const BIRTH_DATES: Readonly<Record<string, string>> = { B1: "1984-05-14", B2: "1982-11-02", B3: "1990-02-27" };
const EMPLOYERS: Readonly<Record<string, string>> = { B1: "Desert Ridge Medical Group", B2: "Salt River Logistics LLC", B3: "Scioto Valley Schools" };
/** The subject: Phoenix, AZ (Maricopa) for the refinance; Columbus, OH for the purchase (worked example 4). */
const SUBJECT = { refinance: { line: "4821 N 24th St", city: "Phoenix", state: "AZ", postal: "85016" }, purchase: { line: "1187 Neil Ave", city: "Columbus", state: "OH", postal: "43201" } } as const;
const RENTAL = { line: "2260 Indianola Ave", unit: "3B", city: "Columbus", state: "OH", postal: "43201" } as const;

const stampAt = (n: number): string => `2026-10-05T14:00:${String(n).padStart(2, "0")}.000Z`;
const D = "BORROWER/DECLARATION/DECLARATION_DETAIL";
const S = "DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY";

/** The 23.1 refinance (or purchase) fixture as the document's graph, with the snapshot's deal facts already laid over it. */
export function refinanceFixtureGraph(snapshot: UladSnapshot, options: RefinanceFixtureOptions = {}): DuGraph {
  const purchase = snapshot.loan_purpose === "purchase";
  const subject = purchase ? SUBJECT.purchase : SUBJECT.refinance;
  const containers: DuContainer[] = [];
  const arcs: DuArc[] = [];
  let n = 0;
  const roleIds: string[] = [];
  const count = BigInt(snapshot.borrowers.length);
  const share = snapshot.qualifying_income_cents / count;
  snapshot.borrowers.forEach((b, i) => {
    const ordinal = i + 1;
    const partyId = `party:${b.borrower_id}`; const roleId = `role:${b.borrower_id}`; const employerId = `employer:${b.borrower_id}`; const incomeId = `income:${b.borrower_id}`;
    roleIds.push(roleId);
    containers.push({ kind: "PARTY", id: partyId, created_at: stampAt(n++), ordinal, parent: null, values: {
      "INDIVIDUAL/NAME/FirstName": FIRST_NAMES[b.borrower_id] ?? "Borrower", "INDIVIDUAL/NAME/LastName": b.last_name, ...(b.suffix ? { "INDIVIDUAL/NAME/SuffixName": b.suffix } : {}),
      "TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER/TaxpayerIdentifierType": "SocialSecurityNumber", "TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER/TaxpayerIdentifierValue": `999${String(ordinal).padStart(2, "0")}${b.ssn_last4}`,
    } });
    const residence: Record<string, DuValue> = purchase
      ? { "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/AddressLineText": RENTAL.line, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/AddressUnitIdentifier": RENTAL.unit, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/CityName": RENTAL.city, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/PostalCode": RENTAL.postal, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/StateCode": RENTAL.state,
        "BORROWER/RESIDENCES/RESIDENCE/LANDLORD/LANDLORD_DETAIL/MonthlyRentAmount": 185_000n, "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyBasisType": "Rent", "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyDurationMonthsCount": 38, "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyType": "Current" }
      : { "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/AddressLineText": subject.line, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/CityName": subject.city, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/PostalCode": subject.postal, "BORROWER/RESIDENCES/RESIDENCE/ADDRESS/StateCode": subject.state,
        "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyBasisType": "Own", "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyDurationMonthsCount": 84, "BORROWER/RESIDENCES/RESIDENCE/RESIDENCE_DETAIL/BorrowerResidencyType": "Current" };
    containers.push({ kind: "ROLE", id: roleId, created_at: stampAt(n++), ordinal, parent: partyId, values: {
      "ROLE_DETAIL/PartyRoleType": "Borrower",
      "BORROWER/BORROWER_DETAIL/BorrowerBirthDate": BIRTH_DATES[b.borrower_id] ?? "1985-01-01", "BORROWER/BORROWER_DETAIL/MaritalStatusType": snapshot.borrowers.length > 1 ? "Married" : "Unmarried",
      [`${D}/BankruptcyIndicator`]: false, [`${D}/CitizenshipResidencyType`]: "USCitizen", [`${D}/HomeownerPastThreeYearsType`]: purchase ? "No" : "Yes", [`${D}/IntentToOccupyType`]: "Yes",
      [`${D}/OutstandingJudgmentsIndicator`]: false, [`${D}/PartyToLawsuitIndicator`]: false, [`${D}/PresentlyDelinquentIndicator`]: false, [`${D}/PriorPropertyDeedInLieuConveyedIndicator`]: false,
      [`${D}/PriorPropertyForeclosureCompletedIndicator`]: false, [`${D}/PriorPropertyShortSaleCompletedIndicator`]: false,
      ...(purchase ? {} : { [`${D}/PriorPropertyTitleType`]: snapshot.borrowers.length > 1 ? "JointWithSpouse" : "Sole", [`${D}/PriorPropertyUsageType`]: "PrimaryResidence" }),
      [`${D}/PropertyProposedCleanEnergyLienIndicator`]: false, [`${D}/UndisclosedBorrowedFundsIndicator`]: false, [`${D}/UndisclosedComakerOfNoteIndicator`]: false,
      [`${D}/UndisclosedCreditApplicationIndicator`]: false, [`${D}/UndisclosedMortgageApplicationIndicator`]: false,
      ...(purchase ? { [`${D}/EXTENSION/OTHER/ULAD:DECLARATION_DETAIL_EXTENSION/ULAD:SpecialBorrowerSellerRelationshipIndicator`]: false } : {}),
      ...residence,
    } });
    containers.push({ kind: "EMPLOYER", id: employerId, created_at: stampAt(n++), parent: roleId, values: {
      "LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName": EMPLOYERS[b.borrower_id] ?? `Employer of ${b.last_name}`,
      "EMPLOYMENT/EmploymentBorrowerSelfEmployedIndicator": false, "EMPLOYMENT/EmploymentClassificationType": "Primary", "EMPLOYMENT/EmploymentStartDate": "2017-03-06", "EMPLOYMENT/EmploymentStatusType": "Current", "EMPLOYMENT/SpecialBorrowerEmployerRelationshipIndicator": false,
    } });
    const monthly = i === 0 ? share + (snapshot.qualifying_income_cents - share * count) : share;
    containers.push({ kind: "CURRENT_INCOME_ITEM", id: incomeId, created_at: stampAt(n++), parent: roleId, values: { "CURRENT_INCOME_ITEM_DETAIL/CurrentIncomeMonthlyTotalAmount": monthly, "CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator": true, "CURRENT_INCOME_ITEM_DETAIL/IncomeType": "Base" } });
    arcs.push({ id: `earns:${incomeId}`, created_at: stampAt(n++), arcrole: "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER", from: incomeId, to: employerId });
  });
  // The joint checking account, every borrower an owner.
  containers.push({ kind: "ASSET", id: "asset:checking", created_at: stampAt(n++), parent: null, values: { "ASSET_DETAIL/AssetAccountIdentifier": "44-118822", "ASSET_DETAIL/AssetCashOrMarketValueAmount": 4_650_000n, "ASSET_DETAIL/AssetType": "CheckingAccount", "ASSET_HOLDER/NAME/FullName": "Desert Sun Credit Union" } });
  for (const r of roleIds) arcs.push({ id: `owner:asset:checking:${r}`, created_at: stampAt(n++), arcrole: "ASSET_IsAssociatedWith_ROLE", from: "asset:checking", to: r });
  if (!purchase) {
    // The subject as an owned property (URLA 3a) with the lien being refinanced, paid off at closing (DI-C04's LIABILITY_1).
    const upb = snapshot.loan_amount_cents - 2_450_000n;
    containers.push({ kind: "ASSET", id: "asset:subject", created_at: stampAt(n++), parent: null, values: {
      "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyDispositionStatusType": "Retain", "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyLienUPBAmount": upb, "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyMaintenanceExpenseAmount": 41_000n, "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertySubjectIndicator": true,
      "OWNED_PROPERTY/PROPERTY/ADDRESS/AddressLineText": subject.line, "OWNED_PROPERTY/PROPERTY/ADDRESS/CityName": subject.city, "OWNED_PROPERTY/PROPERTY/ADDRESS/PostalCode": subject.postal, "OWNED_PROPERTY/PROPERTY/ADDRESS/StateCode": subject.state,
      "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyCurrentUsageType": "PrimaryResidence", "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyEstimatedValueAmount": snapshot.appraised_value_cents, "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyUsageType": "PrimaryResidence",
    } });
    for (const r of roleIds) arcs.push({ id: `owner:asset:subject:${r}`, created_at: stampAt(n++), arcrole: "ASSET_IsAssociatedWith_ROLE", from: "asset:subject", to: r });
    containers.push({ kind: "LIABILITY", id: "liability:mortgage", created_at: stampAt(n++), parent: null, values: {
      "LIABILITY_DETAIL/LiabilityAccountIdentifier": "770231", "LIABILITY_DETAIL/LiabilityExclusionIndicator": false, "LIABILITY_DETAIL/LiabilityMonthlyPaymentAmount": 318_400n, "LIABILITY_DETAIL/LiabilityPaymentIncludesTaxesInsuranceIndicator": false, "LIABILITY_DETAIL/LiabilityPayoffStatusIndicator": true,
      "LIABILITY_DETAIL/LiabilityType": "MortgageLoan", "LIABILITY_DETAIL/LiabilityUnpaidBalanceAmount": upb, "LIABILITY_HOLDER/NAME/FullName": "Camelback Mortgage",
    } });
    for (const r of roleIds) arcs.push({ id: `obligor:liability:mortgage:${r}`, created_at: stampAt(n++), arcrole: "LIABILITY_IsAssociatedWith_ROLE", from: "liability:mortgage", to: r });
    arcs.push({ id: "secures:liability:mortgage", created_at: stampAt(n++), arcrole: "ASSET_IsAssociatedWith_LIABILITY", from: "asset:subject", to: "liability:mortgage" });
  }
  // The snapshot's monthly obligations as the borrowers' revolving debt (23.1 tests move this figure; the bytes move with it).
  containers.push({ kind: "LIABILITY", id: "liability:revolving", created_at: stampAt(n++), parent: null, values: {
    "LIABILITY_DETAIL/LiabilityAccountIdentifier": "5102-8871", "LIABILITY_DETAIL/LiabilityExclusionIndicator": false, "LIABILITY_DETAIL/LiabilityMonthlyPaymentAmount": snapshot.total_obligations_cents, "LIABILITY_DETAIL/LiabilityPayoffStatusIndicator": false,
    "LIABILITY_DETAIL/LiabilityRemainingTermMonthsCount": 24, "LIABILITY_DETAIL/LiabilityType": "Revolving", "LIABILITY_DETAIL/LiabilityUnpaidBalanceAmount": snapshot.total_obligations_cents * 12n, "LIABILITY_HOLDER/NAME/FullName": "Saguaro Card Services",
  } });
  arcs.push({ id: `obligor:liability:revolving:${roleIds[0]}`, created_at: stampAt(n++), arcrole: "LIABILITY_IsAssociatedWith_ROLE", from: "liability:revolving", to: roleIds[0]! });
  const base: DuGraph = {
    application_id: snapshot.application_id, du_casefile_id: options.du_casefile_id ?? null,
    message: {
      "ABOUT_VERSIONS/ABOUT_VERSION/AboutVersionIdentifier": "DU Spec 1.9.3",
      [`${S}/ADDRESS/AddressLineText`]: subject.line, [`${S}/ADDRESS/CityName`]: subject.city, [`${S}/ADDRESS/PostalCode`]: subject.postal, [`${S}/ADDRESS/StateCode`]: subject.state,
      [`${S}/PROPERTY_DETAIL/AttachmentType`]: "Detached", [`${S}/PROPERTY_DETAIL/ConstructionMethodType`]: "SiteBuilt", [`${S}/PROPERTY_DETAIL/PropertyEstateType`]: "FeeSimple",
      [`${S}/PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator`]: false, [`${S}/PROPERTY_DETAIL/PropertyInProjectIndicator`]: false, [`${S}/PROPERTY_DETAIL/PropertyMixedUsageIndicator`]: false, [`${S}/PROPERTY_DETAIL/PropertyStructureBuiltYear`]: 1998,
    },
    containers, arcs,
  };
  return withDeal(base, dealFromSnapshot(snapshot, options.system_id_ref ?? FIXTURE_SYSTEM_ID_REF));
}
