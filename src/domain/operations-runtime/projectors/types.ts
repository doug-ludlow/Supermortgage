/**
 * §35.1 rule 1: "the projector maps the kind's JSON fields onto those columns by an authored map in
 * src/domain/operations-runtime/projectors/<section>.ts (one exported map per kind: { kind, table, mode: insert | upsert,
 * phase: before | commit, columns: { json_field → column }, history: boolean })". The map is data; the runner
 * (../project.ts) copies. Rule 3 (PROJECTOR_NEVER_COMPUTES): a column spec names a JSON field and a column type — the
 * runner validates the type and copies the value; it holds no arithmetic. A money column takes a bigint (or the digit
 * string a bigint becomes on the wire); a `number` in a money column is a `schema_mismatch` gap, never a cast.
 */

export type ColumnType = "uuid" | "money" | "date" | "timestamp" | "text" | "int" | "bool" | "json" | "numeric";

export interface ColumnSpec {
  /** The target column. */
  readonly column: string;
  readonly type: ColumnType;
  /** A NOT NULL column without a default: a version that lacks the field is a `schema_mismatch` gap (never projected, never guessed). */
  readonly required?: boolean;
  /** An enum column: a value outside the set is a `schema_mismatch` gap (the database would refuse the row and roll the command back). */
  readonly values?: readonly string[];
  /** The JSON field is a nested path (`allocation.interest_cents`). */
  readonly path?: readonly string[];
}

/** A child table written beside the row from an array field of the version (2.1's `allocations[]` → `payment_allocations`) or from one object field (2.3's `reversal` → `payment_reversals`). */
export interface ChildMap {
  /** The array (or object) field on the version. */
  readonly field: string;
  readonly table: string;
  /** The child's column that references the parent row's uuid. */
  readonly parentColumn: string;
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  /** The child's natural key beside the parent (`ON CONFLICT (parent, key) DO NOTHING`): a re-projection is a no-op, never a duplicate-key error (rule 4). */
  readonly conflictColumns: readonly string[];
}

export interface ProjectorMap {
  readonly kind: string;
  readonly table: string;
  /** The table's primary-key column (`id`, `lock_id`, `test_id`). */
  readonly idColumn: string;
  readonly mode: "insert" | "upsert";
  readonly phase: "before" | "commit";
  /** Every version of the kind is loaded by hydration (rule 6 HISTORY_KINDS). */
  readonly history: boolean;
  /** The owning process whose Data model fixes the table (named on a money mismatch's escalation). */
  readonly owner: string;
  /** `projector_version` stamped on entity_projections. */
  readonly version: string;
  /** Row projectors this one needs first in the same command (the seam orders them topologically; a cycle is refused at startup). */
  readonly after?: readonly string[];
  /** The scope column the row carries when the version does not name it (`loan_id` from the command's loan). */
  readonly scopeColumn?: { readonly loan?: string; readonly application?: string };
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  readonly children?: readonly ChildMap[];
}

/** Column spec shorthands. */
export const col = (column: string, type: ColumnType, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => ({ column, type, ...o });
export const money = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "money", o);
export const uuid = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "uuid", o);
export const date = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "date", o);
export const ts = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "timestamp", o);
export const text = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "text", o);
export const int = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "int", o);
export const bool = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "bool", o);
export const json = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "json", o);
export const numeric = (column: string, o: Partial<Omit<ColumnSpec, "column" | "type">> = {}): ColumnSpec => col(column, "numeric", o);
