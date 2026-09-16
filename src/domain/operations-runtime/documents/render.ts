/**
 * §35.2 rules 2 and 3 — a notice's block model (src/notices/render.ts) to bytes through the in-repo writer. The placements
 * the writer returns are the layout facts the caller's checklist evaluates (10.4's "≥ 12 pt", 7.1's page-1 rules): the
 * measurement is the placement, and the placement is what was drawn. Determinism: identical (template version, payload,
 * locale, clock, build) → identical bytes (`/ID` from the payload hash, the version and the locale; CreationDate from the
 * command clock). A payload character outside WinAnsi is refused GLYPH_UNSUPPORTED naming the character and the block.
 */
import type { TemplateVersion } from "../../../notices/registry.ts";
import { render, payloadHash, type Rendered, type RenderedBlock } from "../../../notices/render.ts";
import { writePdf, textLayer, sha256Hex, type Placement, type BlockInput } from "../../../infra/files/pdf.ts";

export interface RenderedPdf {
  readonly bytes: Buffer; readonly sha256: string; readonly byte_size: number; readonly page_count: number;
  readonly placements: readonly Placement[]; readonly text: string; readonly payload_hash: string; readonly rendered: Rendered;
  readonly template_code: string; readonly template_version: string; readonly locale: string;
}
export interface RenderOptions { readonly now: string; readonly locale?: string; }

/** HTML entities the block renderer escaped, back to characters for the page. */
const unescapeHtml = (s: string): string => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

export const blocksToInputs = (blocks: readonly RenderedBlock[]): BlockInput[] => blocks.map((b) => ({ id: b.id, page: b.page, yFraction: b.yFraction, pt: b.pt, bold: b.bold, text: unescapeHtml(b.text) }));

/** The notice as a PDF: render the block model, place every block, write the bytes. */
export function renderNoticePdf(version: TemplateVersion, payload: Record<string, unknown>, opts: RenderOptions): RenderedPdf {
  const rendered = render(version.source, payload);
  return renderBlocksPdf(rendered, { template_code: version.templateCode, template_version: version.version, ...opts });
}

/** A rendered block model (already produced by the caller — the notice service) as a PDF. */
export function renderBlocksPdf(rendered: Rendered, meta: { template_code: string; template_version: string } & RenderOptions): RenderedPdf {
  const locale = meta.locale ?? "en";
  const written = writePdf({ blocks: blocksToInputs(rendered.blocks), title: `${meta.template_code} ${meta.template_version}`, idSeed: `${rendered.payloadHash}|${meta.template_version}|${locale}`, creationDate: meta.now });
  return { bytes: written.bytes, sha256: sha256Hex(written.bytes), byte_size: written.bytes.length, page_count: written.page_count, placements: written.placements, text: written.text, payload_hash: rendered.payloadHash, rendered,
    template_code: meta.template_code, template_version: meta.template_version, locale };
}

/** The layout facts the checklist evaluates: the writer's placements projected back onto the block model (rule 3 — the placement is the measurement). */
export function blocksFromPlacements(placements: readonly Placement[], blocks: readonly RenderedBlock[]): RenderedBlock[] {
  const byId = new Map(placements.map((p) => [p.block_id, p] as const));
  return blocks.map((b) => { const p = byId.get(b.id); return p ? { ...b, page: p.page, yFraction: p.y_fraction, pt: p.pt, bold: p.bold } : b; });
}

export { textLayer, payloadHash };
