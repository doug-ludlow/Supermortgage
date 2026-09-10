/**
 * Notice Registry (spec 7.1 "Notice Registry (shared by every section;
 * defined here)"). Templates are identified by their NTC_/INS_ code; each
 * has immutable, effective-dated versions carrying the machine-checkable
 * content rules tied to their citation. A version with a `block` rule that
 * fails against its own sample payload cannot be published; an approved
 * version is never edited — a change is a new version.
 */
import { createHash } from "node:crypto";
import type { PlainDate } from "../kernel/calendar/date.ts";

export type ChannelPolicy = "esign_or_mail" | "mail_only" | "electronic_ok_without_esign";
export type RuleKind = "presence" | "absence" | "layout" | "data_equality" | "data_range" | "conditional" | "cross_ref";
export type Severity = "block" | "warn";
export type PlainLanguageStatus = "draft" | "ai_reviewed" | "counsel_approved" | "retired";

export interface NoticeTemplate {
  readonly code: string;
  readonly name: string;
  readonly citation: string;
  readonly ownerSection: string;              // process id, e.g. "7.1"
  readonly noticeClass: string;               // E-SIGN consent class (7.4)
  readonly channelPolicy: ChannelPolicy;
  readonly separateDocument: boolean;
  readonly mayCombineWith: readonly string[];
  readonly retention: string;
  readonly piiLevel: "low" | "medium" | "high";
  readonly mentions?: readonly string[];
}

/**
 * Predicates are small JSON expressions over the payload (JSONLogic-shaped):
 *   {"var":"path.to.field"} · {"==":[a,b]} · {"!=":[a,b]} · {">":[a,b]} · {">=":[a,b]} · {"<":[a,b]} · {"<=":[a,b]}
 *   {"and":[...]} · {"or":[...]} · {"!":x} · {"in":[x,[...]]} · {"present":"path"} · {"matches":["path","regex"]}
 */
export type Predicate = unknown;

export interface ContentRule {
  readonly rule_id: string;
  readonly citation: string;
  readonly kind: RuleKind;
  /** presence/absence: regex over rendered text; layout: block id; data_*: payload path; conditional: predicate `when` + nested rule; cross_ref: another rule id. */
  readonly selector: string;
  readonly predicate?: Predicate;
  /** For `conditional`: only evaluate when this predicate holds. */
  readonly when?: Predicate;
  /** For `layout`: constraints on the rendered block. */
  readonly layout?: { readonly page?: number; readonly maxYFraction?: number; readonly minFontRatio?: number; readonly bold?: boolean; readonly minPt?: number };
  /** For `data_range`: inclusive bounds (numbers/strings). */
  readonly range?: { readonly min?: number | string; readonly max?: number | string };
  readonly severity: Severity;
  readonly message: string;
}

export interface TemplateVersion {
  readonly templateCode: string;
  readonly version: string;                   // semver
  readonly effectiveFrom: PlainDate;
  readonly effectiveTo?: PlainDate;
  readonly source: string;                    // template body (Handlebars-like) + CSS
  readonly sourceHash: string;
  readonly sampleFormBasis?: string;
  readonly contentRules: readonly ContentRule[];
  readonly layoutRules: readonly ContentRule[];
  readonly readability?: { grade: number; passive_pct: number; sentence_len: number };
  readonly plainLanguageStatus: PlainLanguageStatus;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly ruleSet: string;
  /** Payload the version was validated against at publish time. */
  readonly samplePayload: Record<string, unknown>;
}

export type VersionInput = Omit<TemplateVersion, "sourceHash" | "plainLanguageStatus" | "approvedBy" | "approvedAt"> & { plainLanguageStatus?: PlainLanguageStatus };

export const sourceHash = (source: string): string => createHash("sha256").update(source).digest("hex");

export class TemplateNotPublishable extends Error {
  readonly failures: readonly string[];
  constructor(code: string, version: string, failures: readonly string[]) { super(`${code}@${version} cannot be published: ${failures.join("; ")}`); this.name = "TemplateNotPublishable"; this.failures = failures; }
}

export interface PublishCheck { (v: TemplateVersion): readonly string[]; }

export class NoticeRegistry {
  private readonly templates = new Map<string, NoticeTemplate>();
  private readonly versions = new Map<string, TemplateVersion[]>();

  register(t: NoticeTemplate): void { this.templates.set(t.code, t); }
  template(code: string): NoticeTemplate { const t = this.templates.get(code); if (!t) throw new RangeError(`unknown notice template ${code}`); return t; }
  has(code: string): boolean { return this.templates.has(code); }
  all(): readonly NoticeTemplate[] { return [...this.templates.values()]; }
  bySection(process: string): readonly NoticeTemplate[] { return this.all().filter((t) => t.ownerSection === process); }

  /** Add a draft version (not yet usable for rendering). */
  draft(input: VersionInput): TemplateVersion {
    this.template(input.templateCode);
    const v: TemplateVersion = { ...input, sourceHash: sourceHash(input.source), plainLanguageStatus: input.plainLanguageStatus ?? "draft" };
    let list = this.versions.get(v.templateCode); if (!list) { list = []; this.versions.set(v.templateCode, list); }
    if (list.some((x) => x.version === v.version)) throw new RangeError(`${v.templateCode}@${v.version} already exists; versions are immutable`);
    list.push(v);
    return v;
  }

  /**
   * Publish = counsel approval. The version's block rules are evaluated
   * against its sample payload by `check`; any failure refuses publication
   * (7.1 acceptance: "a template version with a failing block rule cannot be published").
   */
  publish(code: string, version: string, approvedBy: string, approvedAt: string, check: PublishCheck): TemplateVersion {
    const list = this.versions.get(code) ?? [];
    const i = list.findIndex((v) => v.version === version);
    if (i < 0) throw new RangeError(`no ${code}@${version}`);
    const v = list[i]!;
    if (v.plainLanguageStatus === "counsel_approved") return v;
    const failures = check(v);
    if (failures.length) throw new TemplateNotPublishable(code, version, failures);
    const approved: TemplateVersion = { ...v, plainLanguageStatus: "counsel_approved", approvedBy, approvedAt };
    list[i] = approved;
    return approved;
  }

  retire(code: string, version: string, effectiveTo: PlainDate): void {
    const list = this.versions.get(code) ?? [];
    const i = list.findIndex((v) => v.version === version);
    if (i < 0) throw new RangeError(`no ${code}@${version}`);
    list[i] = { ...list[i]!, plainLanguageStatus: "retired", effectiveTo };
  }

  /** The approved version in effect on `asOf` (latest effectiveFrom ≤ asOf, not retired/expired). */
  activeVersion(code: string, asOf: PlainDate): TemplateVersion | undefined {
    return (this.versions.get(code) ?? [])
      .filter((v) => v.plainLanguageStatus === "counsel_approved" && v.effectiveFrom <= asOf && (v.effectiveTo === undefined || v.effectiveTo >= asOf))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  }
  versionsOf(code: string): readonly TemplateVersion[] { return this.versions.get(code) ?? []; }
}
