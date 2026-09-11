/**
 * Fixtures mode (NEXT_PUBLIC_FIXTURES=1): the shell renders a recorded `borrower_record`,
 * thread and cards from apps/borrower/fixtures/*.json instead of the API, so the app can
 * be demoed before the API seam lands. Card resolution mutates the in-memory fixture.
 *
 * FAKE: everything here — vendors, agents, timers, notices — is recorded, not live.
 */
import type { AnyCardInstance } from "@/lib/types/cards";
import type { BorrowerMe, BorrowerRecord, ThreadMessage } from "@/lib/types/record";
import refinance from "@/fixtures/refinance.json";
import servicing from "@/fixtures/servicing.json";

export type Fixture = {
  name: string;
  source: string; // the docs/ux section it was authored from
  me: BorrowerMe;
  record: BorrowerRecord;
  messages: ThreadMessage[];
  cards: AnyCardInstance[];
};

export const FIXTURES: Record<string, Fixture> = {
  refinance: refinance as unknown as Fixture,
  servicing: servicing as unknown as Fixture,
};

export const DEFAULT_FIXTURE = "refinance";

export function loadFixture(name: string | null | undefined): Fixture {
  const f = FIXTURES[name ?? DEFAULT_FIXTURE] ?? FIXTURES[DEFAULT_FIXTURE]!;
  // deep clone so in-memory resolution never mutates the imported module
  return JSON.parse(JSON.stringify(f)) as Fixture;
}
