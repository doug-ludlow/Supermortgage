/**
 * Borrower API errors (docs/ux/02-data-contracts.md §7): every refusal answers `{code, gate?, copy_key}` and nothing else —
 * no reason text, no citation, no internal state (13 §1 contract tests). A `CommandRefused` from the bus maps to its code
 * (a gate-shaped code — `*_GATE`, or a registry timer code the command waited on — also fills `gate`); a `GateClosed`
 * from an evaluator fills `gate` with its ref; validation errors are `BAD_REQUEST`.
 */
import { CommandRefused, AiPathUnavailable } from "../../app/commands.ts";
import { GateClosed } from "../../app/evaluators.ts";
import { RoleDenied } from "../../app/roles.ts";
import { PortUnavailable } from "../../app/tools.ts";
import { ToolNotFound } from "../app.ts";
import { copyKeyFor } from "./copy-keys.ts";

export interface BorrowerErrorBody { readonly code: string; readonly gate?: string; readonly copy_key: string; }

export class BorrowerError extends Error {
  readonly status: number; readonly code: string; readonly gate: string | undefined;
  constructor(status: number, code: string, gate?: string, detail?: string) { super(detail ?? code); this.name = "BorrowerError"; this.status = status; this.code = code; this.gate = gate; }
  body(): BorrowerErrorBody { return { code: this.code, ...(this.gate ? { gate: this.gate } : {}), copy_key: copyKeyFor(this.code, this.gate) }; }
}

const GATE_SHAPED = /_GATE$|_GATE_|^(REGZ|REGX|REGB|REGV|FCRA|ESIGN|TCPA|FNMA|HPA|FDPA|SM_O\d|SM_[A-Z0-9_]+_\d+[A-Z]*)_/;
export const looksLikeGate = (code: string): boolean => GATE_SHAPED.test(code);

/** Anything thrown on a borrower route → a BorrowerError with the documented status. */
export function toBorrowerError(e: unknown): BorrowerError {
  if (e instanceof BorrowerError) return e;
  if (e instanceof CommandRefused) return new BorrowerError(409, e.code, looksLikeGate(e.code) ? e.code : undefined, e.message);
  if (e instanceof GateClosed) return new BorrowerError(409, "GATE_CLOSED", e.ref, e.message);
  if (e instanceof RoleDenied) return new BorrowerError(403, "ROLE_DENIED", undefined, e.message);
  if (e instanceof AiPathUnavailable) return new BorrowerError(503, "AI_OFF", undefined, e.message);
  if (e instanceof ToolNotFound) return new BorrowerError(404, "NOT_FOUND", undefined, e.message);
  if (e instanceof PortUnavailable) return new BorrowerError(501, "NOT_WIRED", undefined, e.message);
  if (e instanceof RangeError || e instanceof TypeError || e instanceof SyntaxError) return new BorrowerError(400, "BAD_REQUEST", undefined, e.message);
  return new BorrowerError(500, "INTERNAL", undefined, e instanceof Error ? e.message : String(e));
}
