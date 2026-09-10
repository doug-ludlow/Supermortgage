/**
 * MERS Mortgage Identification Number: 18 digits = 7-digit Org ID + 10-digit
 * sequence + 1 Mod-10 (Luhn) check digit. The spec tags the algorithm as
 * [PARTIALLY VERIFIED — from Member Guide practice]; it is isolated here so a
 * confirmed variant is a one-line change.
 */
export const MIN_LENGTH = 18;

export function luhnCheckDigit(payload: string): number {
  if (!/^\d+$/.test(payload)) throw new TypeError("payload must be digits");
  let sum = 0, dbl = true;               // rightmost payload digit is doubled (check digit position is the un-doubled one)
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = Number(payload[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidMin(min: string): boolean {
  if (!/^\d{18}$/.test(min)) return false;
  return luhnCheckDigit(min.slice(0, 17)) === Number(min[17]);
}

export function minOrgId(min: string): string { return min.slice(0, 7); }

/** Build a valid MIN for tests/fixtures. */
export function makeMin(orgId: string, sequence: string): string {
  const payload = orgId.padStart(7, "0") + sequence.padStart(10, "0");
  if (payload.length !== 17) throw new RangeError("orgId(7) + sequence(10) required");
  return payload + String(luhnCheckDigit(payload));
}
