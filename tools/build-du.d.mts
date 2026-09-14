/**
 * Types for tools/build-du.mjs, which is plain JavaScript so that
 * `node tools/build-du.mjs --verify` runs on every runner with no flag.
 *
 * Hand-maintained beside the script: `tsc --noEmit` has no `allowJs`, so the
 * node:test suites under src/domain/underwriting/du reach the generator's
 * exports through this file. Keep it in step with the script's `export`s — an
 * export missing here is one the tests cannot import, which is a loud failure,
 * and a shape wrong here is a quiet one, which is why the shapes are narrow.
 */

export interface SheetRow {
  number: number;
  cells: string[];
}

export interface Workbook {
  sheet(name: string): SheetRow[];
}

export class SpecUnavailableError extends Error {
  unset: boolean;
  constructor(message: string, options: { unset: boolean });
}

export function resolveSpecFiles(env?: Record<string, string | undefined>): { workbook: string };
export function readWorkbook(path: string): Workbook;
export function normalizeFormFieldId(value: string | undefined): string;
export const COLUMN_NAME_ALIASES: Readonly<Record<string, string>>;
export function arcRoleColumnNamesFor(
  columnDescription: readonly SheetRow[],
  sections: Readonly<Record<string, string>>,
): Record<string, string[]>;

export interface SchemaChild {
  name: string;
  type: string | null;
  prefix: string;
}
export interface SchemaLike {
  childrenOf(type: string): SchemaChild[] | null;
}
export function buildOrderTable(
  schema: SchemaLike,
  xpaths: readonly string[],
): { order: Map<string, string[]>; typeForPath: Map<string, string> };

export interface DuDataPoint {
  name: string;
  formFields: string[];
}
export interface DuEnumSpec {
  dataPoints?: DuDataPoint[];
  exclude?: string[];
  local?: boolean;
}
export const DU_DATA_POINT_FOR_ENUM: Readonly<Record<string, DuEnumSpec>>;

export interface TabDisagreement {
  dataPoint: string;
  mapFormField: string;
  enumerationFormField: string;
}
export const TAB_DISAGREEMENTS: readonly TabDisagreement[];

export interface BlankEnumerationCell {
  dataPoint: string;
  ediCode: string;
  value: string | null;
}
export const BLANK_ENUMERATION_CELLS: readonly BlankEnumerationCell[];

export interface ValuesNotInScope {
  enumName: string;
  values: string[];
}
export const VALUES_NOT_IN_SCOPE: readonly ValuesNotInScope[];

export interface EnumerationRow {
  rowNumber: number;
  formFieldId: string;
  formFieldName: string;
  dataPoint: string;
  value: string;
  ediCode: string;
}
export interface MapRow {
  rowNumber: number;
  formFieldId: string;
  formFieldName: string;
  xpath: string;
  dataPoint: string;
  attribute: string;
  format: string;
  du: string;
  conditionality: string;
}
export interface EnumerationOptions {
  table?: Record<string, DuEnumSpec>;
  disagreements?: readonly TabDisagreement[];
  blanks?: readonly BlankEnumerationCell[];
  notInScope?: readonly ValuesNotInScope[];
}
export function deriveEnumerations(
  rows: readonly EnumerationRow[],
  options?: EnumerationOptions,
): { enumerations: Record<string, string[]>; local: string[] };

export interface AssetTypeSection {
  kind: string;
  formField: string;
  constraint: string;
}
export const ASSET_TYPE_SECTIONS: readonly AssetTypeSection[];
export function deriveAssetTypeSections(
  rows: readonly EnumerationRow[],
  options?: { sections?: readonly AssetTypeSection[] },
): Record<string, string[]>;
export function parseGeneratedAssetTypeSections(source: string): Record<string, string[]>;
export function assetTypeListsInMigration(
  sql: string,
  options?: { sections?: readonly AssetTypeSection[]; path?: string },
): Record<string, string[]>;
export function diffAssetTypeChecks(
  sections: Record<string, string[]>,
  migrationLists: Record<string, string[]>,
  assetTypeMembers: readonly string[],
  options?: { sections?: readonly AssetTypeSection[] },
): string[];

export interface ParsedFormat {
  kind: string;
  maxLength?: number;
  digits?: number;
  decimals?: number;
}
export function parseFormat(prose: string): ParsedFormat;
export const BLANK_FORMAT_ROWS: ReadonlyArray<{ xpath: string; dataPoint: string }>;

export type Condition =
  | { kind: "self_exists" }
  | { kind: "exists"; dataPoint: string }
  | { kind: "absent"; dataPoint: string }
  | { kind: "compare"; dataPoint: string; operator: string; value: string | number }
  | { kind: "in"; dataPoint: string; values: string[] }
  | { kind: "and"; terms: Condition[] }
  | { kind: "or"; terms: Condition[] };
export function parseConditionality(statement: string): Condition;
export const UNPARSEABLE_STATEMENTS: ReadonlyArray<{ statement: string; condition: Condition }>;

export function parseCardinality(cell: string, xpath: string): { min: number; max: number } | null;

export const ARCROLE_SECTIONS: { readonly endpoints: string; readonly relationships: string };
export const ARCROLE_VERB_PHRASES: readonly string[];
export interface ArcRoleDisagreement {
  arcrole: string;
  end: "from" | "to";
}
export const ARCROLE_ENDPOINT_DISAGREEMENTS: readonly ArcRoleDisagreement[];
export function arcRolesInCorpus(dir?: string): Map<string, number>;

export interface EndpointRow {
  rowNumber: number;
  arcRole: string;
  fromXPath: string;
  source: string;
  verbPhrase: string;
  toXPath: string;
  target: string;
}
export interface RelationshipRow {
  rowNumber: number;
  arcRole: string;
  xpath: string;
  attribute: string;
  label: string;
  value: string;
  notes: string;
}
export interface ArcRoleSections {
  endpoints: EndpointRow[];
  relationships: RelationshipRow[];
}
export interface ArcRoleEndpoint {
  xpath: string;
  container: string;
  relationshipEnd: string;
  arcroleTerm: string;
  disputed: boolean;
}
export interface ArcRole {
  arcrole: string;
  name: string;
  verbPhrase: string;
  from: ArcRoleEndpoint;
  to: ArcRoleEndpoint;
  note: string;
  exercised: boolean;
}
export function deriveArcRoles(
  sections: ArcRoleSections,
  corpus: Map<string, number>,
  options?: { disagreements?: readonly ArcRoleDisagreement[] },
): { table: Record<string, ArcRole>; relationshipXPath: string };
export function readArcRoleSections(
  rows: readonly SheetRow[],
  columnDescription: readonly SheetRow[],
): ArcRoleSections;

export function parseGeneratedEnums(source: string): {
  enumerations: Record<string, string[]>;
  local: string[];
};
export function parseGeneratedOrder(source: string): {
  childOrder: Record<string, string[]>;
  typeForPath: Record<string, string>;
};
export function parseGeneratedArcRoles(source: string): Record<string, ArcRole>;

export function checkTabDisagreements(
  map: readonly MapRow[],
  enumerations: readonly EnumerationRow[],
  options?: { table?: Record<string, DuEnumSpec>; disagreements?: readonly TabDisagreement[] },
): void;
export function buildFromSpec(paths: { workbook: string }): Record<string, string>;

export const DU_GRAPH_MIGRATION_GLOB: string;
export function duGraphMigrationPaths(root?: string): string[];
export function migrationSources(root?: string): Array<{ file: string; sql: string }>;
export function splitSqlStatements(sql: string): string[];
export interface DuEnumChecks {
  comments: Map<string, { dataPoint: string; file: string }>;
  lists: Map<string, Array<{ file: string; values: string[] }>>;
}
export function duEnumChecksInMigrations(
  sources: ReadonlyArray<{ file: string; sql: string }>,
): DuEnumChecks;
export function diffDuEnumChecks(
  found: DuEnumChecks,
  derived: Readonly<Record<string, readonly string[]>>,
  table?: Record<string, DuEnumSpec>,
): string[];
export function schemaOrderProblems(source: string): { problems: string[]; count: number };
