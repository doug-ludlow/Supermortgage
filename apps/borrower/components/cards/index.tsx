"use client";

import type { AnyCardInstance, CardKind } from "@/lib/types/cards";
import type { CardComponentProps } from "./types";
import { StatusCard } from "./StatusCard";
import { ChoiceCard } from "./ChoiceCard";
import { ConfirmCard } from "./ConfirmCard";
import { ConnectCard } from "./ConnectCard";
import { ConsentCard } from "./ConsentCard";
import { DocumentCard } from "./DocumentCard";
import { ComparisonCard } from "./ComparisonCard";
import { ChecklistCard } from "./ChecklistCard";
import { UploadCard } from "./UploadCard";
import { ExplanationCard } from "./ExplanationCard";
import { ScheduleCard } from "./ScheduleCard";
import { PaymentCard } from "./PaymentCard";
import { InviteCard } from "./InviteCard";
import { HandoffCard } from "./HandoffCard";
import { OfferCard } from "./OfferCard";
import { NoticeCard } from "./NoticeCard";
import { PersonCard } from "./PersonCard";
import { ProfileCard } from "./ProfileCard";
import { DemographicsCard } from "./DemographicsCard";

export {
  StatusCard,
  ChoiceCard,
  ConfirmCard,
  ConnectCard,
  ConsentCard,
  DocumentCard,
  ComparisonCard,
  ChecklistCard,
  UploadCard,
  ExplanationCard,
  ScheduleCard,
  PaymentCard,
  InviteCard,
  HandoffCard,
  OfferCard,
  NoticeCard,
  PersonCard,
  ProfileCard,
  DemographicsCard,
};
export type { CardComponentProps } from "./types";

type Common = Omit<CardComponentProps<CardKind>, "card">;

/** Render any `card_instances` row with the component for its kind. */
export function Card({ card, comparisonStub, ...rest }: Common & { card: AnyCardInstance; comparisonStub?: boolean }) {
  switch (card.kind) {
    case "StatusCard":
      return <StatusCard card={card} {...rest} />;
    case "ChoiceCard":
      return <ChoiceCard card={card} {...rest} />;
    case "ConfirmCard":
      return <ConfirmCard card={card} {...rest} />;
    case "ConnectCard":
      return <ConnectCard card={card} {...rest} />;
    case "ConsentCard":
      return <ConsentCard card={card} {...rest} />;
    case "DocumentCard":
      return <DocumentCard card={card} {...rest} />;
    case "ComparisonCard":
      return <ComparisonCard card={card} {...rest} stub={comparisonStub} />;
    case "ChecklistCard":
      return <ChecklistCard card={card} {...rest} />;
    case "UploadCard":
      return <UploadCard card={card} {...rest} />;
    case "ExplanationCard":
      return <ExplanationCard card={card} {...rest} />;
    case "ScheduleCard":
      return <ScheduleCard card={card} {...rest} />;
    case "PaymentCard":
      return <PaymentCard card={card} {...rest} />;
    case "InviteCard":
      return <InviteCard card={card} {...rest} />;
    case "HandoffCard":
      return <HandoffCard card={card} {...rest} />;
    case "OfferCard":
      return <OfferCard card={card} {...rest} />;
    case "NoticeCard":
      return <NoticeCard card={card} {...rest} />;
    case "PersonCard":
      return <PersonCard card={card} {...rest} />;
    case "ProfileCard":
      return <ProfileCard card={card} {...rest} />;
    case "DemographicsCard":
      return <DemographicsCard card={card} {...rest} />;
  }
}
