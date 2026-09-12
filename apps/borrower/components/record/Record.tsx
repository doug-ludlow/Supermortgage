"use client";

import type { AnyCardInstance, ResolveRequest } from "@/lib/types/cards";
import type { BorrowerRecord } from "@/lib/types/record";
import type { CardComponentProps } from "@/components/cards/types";
import { Rail } from "./Rail";
import type { RecordLink } from "./sections";

export type RecordProps = {
  record?: BorrowerRecord;
  cards: Record<string, AnyCardInstance>;
  timezone: string;
  cardProps: Pick<CardComponentProps<"StatusCard">, "onOpen" | "onLaunchVendor" | "onUpload" | "onMessage">;
  resolve: (card: AnyCardInstance, req: ResolveRequest) => Promise<void>;
  busyCardId?: string;
  cardErrors: Record<string, string>;
  currentAskId?: string;
  focus?: { card_instance_id: string; seq: number };
  link: RecordLink;
  /** Open as the drawer (768–1023) or the bottom sheet (< 768); ignored beside the thread. */
  open: boolean;
  onClose: () => void;
};

/** 32.16 §2.2 — the rail (the Record panel): the sections of `Rail`, beside the thread at ≥ 1024, a drawer at 768–1023, the bottom sheet the status strip opens on a phone. */
export function Record({ open, onClose, ...rail }: RecordProps) {
  return (
    <aside className="sm-record" data-open={open} aria-label="Your record" data-testid="record">
      {open ? (
        <button type="button" className="sm-btn sm-btn-quiet sm-record-close" onClick={onClose} aria-label="Close your record">
          ✕ Close
        </button>
      ) : null}
      <Rail {...rail} />
    </aside>
  );
}
