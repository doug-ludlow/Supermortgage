/**
 * 32.3 E5 / SQ-06 — the residence a borrower states on the identity card (Own · Rent with the monthly rent · Living
 * rent-free, and the months at the address) and on the prior-residence card, translated into 23.5 `writeResidence`'s
 * input (`du_residences`: residency_basis, monthly_rent_cents iff Rent — CHECK du_residences_rent_iff_rent_basis —
 * duration_months 0..999, and the address parts the wire allows: line ≤ 50, city ≤ 35, a 5- or 9-digit ZIP).
 *
 * The card's option ids are the borrower's plain choices; the DU vocabulary (23.5) is a translation here, never a
 * word on a card.
 */
export const RESIDENCY_BASIS_OF_OPTION: Readonly<Record<string, "Own" | "Rent" | "LivingRentFree">> = { own: "Own", rent: "Rent", living_rent_free: "LivingRentFree" };
/** The option ids the two cards offer, in the order the spec lists them (E5: Own · Rent · Living rent-free). */
export const RESIDENCY_BASIS_OPTIONS: readonly { id: string; label: string }[] = [{ id: "own", label: "I own it" }, { id: "rent", label: "I rent" }, { id: "living_rent_free", label: "Living rent-free" }];

export interface ResidenceAddressParts { readonly address_line_text?: string; readonly city_name?: string; readonly state_code?: string; readonly postal_code?: string; readonly country_code?: string }

const clip = (s: string, n: number): string => s.trim().replace(/\s+/g, " ").slice(0, n);
/** A postal code as the wire takes it: five digits, or nine (a ZIP+4 loses its dash); anything else is not a postal code. */
export const postalDigits = (s: string): string | null => { const d = s.replace(/\D/g, ""); return d.length === 5 || d.length === 9 ? d : null; };

/**
 * A one-line US address ("100 N Central Ave, Phoenix, AZ 85004" · "22 Elm St") into the parts a Current residence can
 * carry (every part nullable on a Current row — a bare street line is fine; a Prior row needs all four, so the
 * prior-residence card asks them separately). Best effort, never invented: a part that does not parse is left out.
 */
export function parseAddressLine(address: string): ResidenceAddressParts {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return {};
  const out: { address_line_text?: string; city_name?: string; state_code?: string; postal_code?: string; country_code?: string } = { address_line_text: clip(parts[0]!, 50) };
  const tail = parts.slice(1);
  const last = tail.at(-1);
  const stateZip = last ? /^([A-Za-z]{2})\s*(\d{5}(?:-?\d{4})?)?$/.exec(last) : null;
  if (stateZip) {
    out.state_code = stateZip[1]!.toUpperCase(); const zip = stateZip[2] ? postalDigits(stateZip[2]) : null; if (zip) out.postal_code = zip;
    const city = tail.slice(0, -1).join(", "); if (city) out.city_name = clip(city, 35);
    out.country_code = "US";
  } else if (tail.length) {
    out.city_name = clip(tail.join(", "), 35);
  }
  return out;
}

export interface StatedResidence { readonly basis_option: string; readonly monthly_rent_cents: string; readonly months: string }
/** The validated 23.5 `residence` input from what the card confirmed (option id → DU basis; the rent iff Rent; whole months 0..999). */
export function residenceInput(kind: "Current" | "Prior", stated: StatedResidence, address: ResidenceAddressParts): Record<string, unknown> {
  const residency_basis = RESIDENCY_BASIS_OF_OPTION[stated.basis_option];
  if (!residency_basis) throw new RangeError(`residency_basis must be one of ${Object.keys(RESIDENCY_BASIS_OF_OPTION).join("/")}`);
  if (!/^\d{1,3}$/.test(stated.months.trim())) throw new RangeError("months at the address must be a whole number of months (0–999)");
  const duration_months = Number(stated.months.trim());
  let rent: bigint | null = null;
  if (residency_basis === "Rent") {
    if (!/^\d+$/.test(stated.monthly_rent_cents.trim())) throw new RangeError("monthly_rent_cents is required when the basis is Rent (a decimal string of cents)");
    rent = BigInt(stated.monthly_rent_cents.trim());
  }
  if (kind === "Prior" && (!address.address_line_text || !address.city_name || !address.state_code || !address.postal_code)) throw new RangeError("a prior residence carries its own street address, city, state and ZIP");
  return { residency_type: kind, residency_basis, ...(rent !== null ? { monthly_rent_cents: rent.toString() } : {}), duration_months, ...address };
}
