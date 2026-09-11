"use client";

import { CardFrame } from "./CardFrame";
import type { CardComponentProps } from "./types";
import type { PersonRole } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

const ROLE_LABEL: Record<PersonRole, string> = {
  mlo_of_record: "Your loan officer",
  human_agent: "A person on your loan",
  notary: "Your notary",
  settlement_agent: "Your settlement agent",
  continuity_of_contact_team: "Your team",
  appraiser: "Your appraiser",
};

/** 01 §3.17 — introduce a human the borrower will deal with. */
export function PersonCard({ card, timezone }: CardComponentProps<"PersonCard">) {
  const p = card.props;
  const name = p.name || (p.name_copy_key ? copy(p.name_copy_key) : "");
  const intro = p.intro || (p.intro_copy_key ? copy(p.intro_copy_key, { name }) : undefined);
  const initials = name
    .split(/\s+/)
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <CardFrame card={card} timezone={timezone} title={`${ROLE_LABEL[p.role]}: ${name}`} collapsible={false}>
      <div className="sm-person">
        <span className="sm-avatar" aria-hidden="true">
          {initials}
        </span>
        <div>
          <div className="sm-primary-text">{name}</div>
          {p.credentials ? <div className="sm-source">{p.credentials}</div> : null}
          {p.reach ? (
            <div>
              <a href={`tel:${p.reach.replace(/[^\d+]/g, "")}`}>{p.reach}</a>
            </div>
          ) : null}
        </div>
      </div>
      {intro ? <p>{intro}</p> : null}
    </CardFrame>
  );
}
