"use client";

import { Component, type ReactNode } from "react";
import type { AnyCardInstance } from "@/lib/types/cards";
import { copy } from "@/lib/copy";

/**
 * 32.13 (01 §10 degraded states): one card that cannot render never takes the thread down. The frame stays addressable
 * (`article[data-card-kind][data-card-id]`, status `error`) so the harness can see which card failed; the borrower reads
 * `error.generic` — never a stack, never a code.
 */
export class CardBoundary extends Component<{ card: AnyCardInstance; children: ReactNode }, { failed: string | null }> {
  state: { failed: string | null } = { failed: null };
  static getDerivedStateFromError(e: unknown): { failed: string } {
    return { failed: e instanceof Error ? e.message : String(e) };
  }
  override componentDidUpdate(prev: { card: AnyCardInstance }): void {
    if (prev.card !== this.props.card && this.state.failed) this.setState({ failed: null });
  }
  override render(): ReactNode {
    if (this.state.failed === null) return this.props.children;
    const c = this.props.card;
    return (
      <article className="sm-card" data-card-kind={c.kind} data-card-id={c.card_instance_id} data-status="error" data-testid="card-error" data-error={this.state.failed} aria-live="polite">
        <p className="sm-muted" style={{ margin: 0 }}>{copy("error.generic")}</p>
      </article>
    );
  }
}
