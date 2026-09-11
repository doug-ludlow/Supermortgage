"use client";

import type { ReactNode } from "react";
import type { BorrowerRecord } from "@/lib/types/record";
import { DatesSection, DocumentsSection, HeaderSection, LoanSection, NeededSection, NextSection, NumbersSection, PeopleSection, PropertySection, StatusSection, type RecordLink } from "./sections";

/** 01 §1.1 Record — a read-only projection of `borrower_record`; sections in fixed order (01 §4). */
export function Record({ record, link, open, onClose, children }: { record?: BorrowerRecord; link: RecordLink; open: boolean; onClose: () => void; children?: ReactNode }) {
  return (
    <aside className="sm-record" data-open={open} aria-label="Your record" data-testid="record">
      {open ? (
        <button type="button" className="sm-btn sm-btn-quiet sm-record-close" onClick={onClose} aria-label="Close your record">
          ✕ Close
        </button>
      ) : null}
      {!record ? (
        <p className="sm-empty">Your record appears here once we know what we're doing today.</p>
      ) : (
        <>
          <HeaderSection r={record} />
          <StatusSection r={record} link={link} />
          {children}
          <NextSection r={record} link={link} />
          <NeededSection r={record} link={link} />
          <NumbersSection r={record} />
          <DatesSection r={record} link={link} />
          <DocumentsSection r={record} link={link} />
          <PeopleSection r={record} />
          <PropertySection r={record} />
          <LoanSection r={record} />
        </>
      )}
    </aside>
  );
}
