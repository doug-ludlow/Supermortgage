/**
 * 34.5 `portal.home` — Home is My queue for every role held (rule 2; Q5 decided: one merged list with the role on each row):
 *
 *   clocks         the clocks due within 24 hours and the breached clocks with code, subject and breach role (34.4's controls.timers
 *                  read, src/runtime/controls/timers.ts — the registry's breach role, so the view agrees with the escalation the
 *                  breach opened)
 *   escalations    the open escalations counted by role
 *   my_queue       the work waiting for every ops role the session holds as ONE list — the five console kinds (escalation, portal
 *                  task, held notice, dead letter, breached timer) through PgConsoleStore.queue per role, merged by row, each row
 *                  naming the role it needs (`needs`, the row's owner role) and the held roles whose queue lists it (`queue_roles`);
 *                  "Act as" is a filter, never a gate; `?kind=` keeps the queue's filter
 *   counts         the dead-letter, held-notice and open portal-task counts
 *   fake_reviewers the roles a FAKE reviewer fills in this environment (src/infra/integrations/reviewers.ts's roster; null when off)
 *   admin          when the session holds `admin`: the staff, access-review and controls tiles and one line naming the roles the
 *                  other areas need
 *   areas          the eight areas in their fixed order, only those the session's roles open (rule 1: nothing on the screen is a
 *                  link to a refusal)
 *
 * For an account holding `admin` only, `clocks`, `escalations`, `my_queue` and `counts` are null — no count or field derived from a
 * borrower party, application or loan reaches it (34.1 rule 2 is not blurred for a tile). Every look is `portal.home.viewed
 * {staff_user_id, roles}` (LOG_EVERY_LOOK). The tool projects; it writes nothing else (READ_ONLY).
 */
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { PgConsoleStore } from "../../console/pg-store.ts";
import type { QueueItem } from "../../console/store.ts";
import { controlsTimers, type ControlsTimerRow } from "../controls/timers.ts";
import { OPS_ROLES, STAFF_ROLES } from "../staff/roles.ts";

export const PORTAL_PROCESS = "34.5";
export const HOME_ROLES: readonly string[] = STAFF_ROLES;
export const QUEUE_KINDS: readonly QueueItem["kind"][] = ["escalation", "portal_task", "held_notice", "dead_letter", "breached_timer"];
const isQueueKind = (v: unknown): v is QueueItem["kind"] => typeof v === "string" && (QUEUE_KINDS as readonly string[]).includes(v);

/** Rule 1: the eight areas, their order and the roles that open each (the sidebar shows only what the session's roles open). */
export const PORTAL_AREAS: readonly { code: string; label: string; roles: readonly string[] }[] = [
  { code: "home", label: "Home", roles: STAFF_ROLES },
  { code: "people", label: "People & accounts", roles: OPS_ROLES },
  { code: "pipeline", label: "Pipeline", roles: OPS_ROLES },
  { code: "loans", label: "Loans", roles: OPS_ROLES },
  { code: "partner_book", label: "Partner book", roles: OPS_ROLES },
  { code: "operations", label: "Operations", roles: STAFF_ROLES },
  { code: "oversight", label: "Oversight", roles: STAFF_ROLES },
  { code: "staff", label: "Staff", roles: ["admin", "compliance"] },
];
/** The one line an admin-only Home shows for the areas it does not open. */
export const OTHER_AREAS_NEED = `People & accounts, Pipeline, Loans and Partner book need ${OPS_ROLES.join(", ")}; Operations is worked by those roles (admin reads its outbox); the controls are read by every role; the action log by admin and compliance (analysts and officers see their own rows)`;

export interface HomeClock { readonly timer_id: string; readonly code: string; readonly status: string; readonly subject_kind: string; readonly subject_id: string; readonly loan_id: string | null; readonly application_id: string | null; readonly due_at: string | null; readonly due_date: string | null; readonly breached_at: string | null; readonly breach_role: string | null; readonly severity: number | null; readonly process: string | null }
export interface HomeQueueRow { readonly id: string; readonly kind: QueueItem["kind"]; readonly title: string; readonly needs: string; readonly held: boolean; readonly queue_roles: readonly string[]; readonly loan_id: string | null; readonly severity: string | null; readonly opened_at: string; readonly due_at: string | null; readonly fake_reviewer: { role: string; approves_after_s: number; marker: "FAKE" } | null; readonly detail: Record<string, unknown> }
export interface PortalHome {
  readonly as_of: string; readonly acted_as: string; readonly roles: readonly string[]; readonly ops_roles: readonly string[]; readonly kind: QueueItem["kind"] | null;
  readonly areas: readonly { code: string; label: string }[];
  readonly clocks: { readonly due_24h: readonly HomeClock[]; readonly breached: readonly HomeClock[]; readonly counts: { due_24h: number; breached: number } } | null;
  readonly escalations: { readonly open_by_role: Readonly<Record<string, number>>; readonly open: number } | null;
  readonly my_queue: { readonly title: "My queue"; readonly rows: readonly HomeQueueRow[]; readonly count: number; readonly by_kind: Readonly<Record<QueueItem["kind"], number>>; readonly by_role: Readonly<Record<string, number>> } | null;
  readonly counts: { readonly dead_letters: number; readonly held_notices: number; readonly portal_tasks: number } | null;
  readonly fake_reviewers: { readonly roles: readonly string[]; readonly delay_s: number; readonly marker: "FAKE" } | null;
  readonly admin: { readonly tiles: readonly { code: "staff" | "access_review" | "controls"; label: string; path: string; detail: Record<string, unknown> }[]; readonly other_areas: string } | null;
}
export interface PortalHomeOptions { readonly acted_as: string; readonly roles: readonly string[]; readonly kind?: string | null; readonly now?: string }

const clockOf = (t: ControlsTimerRow): HomeClock => ({ timer_id: t.timer_id, code: t.code, status: t.status, subject_kind: t.subject_kind, subject_id: t.subject_id, loan_id: t.loan_id, application_id: t.application_id, due_at: t.due_at, due_date: t.due_date, breached_at: t.breached_at, breach_role: t.breach_role, severity: t.severity, process: t.process });

/** The projection (no log) — `portalHomeLogged` below adds the `portal.home.viewed` event. */
export async function portalHome(rt: Runtime, opts: PortalHomeOptions): Promise<PortalHome> {
  const now = opts.now ?? rt.clock.now();
  const held: readonly string[] = STAFF_ROLES.filter((r) => opts.roles.includes(r));
  const ops: readonly string[] = OPS_ROLES.filter((r) => held.includes(r));
  const kind = isQueueKind(opts.kind) ? opts.kind : null;
  const areas = PORTAL_AREAS.filter((a) => a.roles.some((r) => held.includes(r))).map((a) => ({ code: a.code, label: a.label }));
  const fake = rt.reviewers ? { roles: [...rt.reviewers.roles], delay_s: rt.reviewers.delaySeconds, marker: "FAKE" as const } : null;
  let clocks: PortalHome["clocks"] = null; let escalations: PortalHome["escalations"] = null; let my_queue: PortalHome["my_queue"] = null; let counts: PortalHome["counts"] = null;
  if (ops.length) {
    // the clocks (34.4 rule 1's read): armed and due within 24 hours; breached — with the registry's breach role
    const horizon = new Date(Date.parse(now) + 24 * 3600_000).toISOString();
    const [due, breached] = await Promise.all([controlsTimers(rt, { status: "armed", due_before: horizon, limit: 500 }, now), controlsTimers(rt, { status: "breached", limit: 500 }, now)]);
    clocks = { due_24h: due.timers.map(clockOf), breached: breached.timers.map(clockOf), counts: { due_24h: due.count, breached: breached.counts.breached } };
    const byRole: Record<string, number> = {};
    for (const r of await rt.db.query<{ owner_role: string | null; n: string }>(`SELECT owner_role, count(*)::text AS n FROM escalations WHERE completed_at IS NULL GROUP BY owner_role ORDER BY owner_role`)) byRole[r.owner_role ?? "unassigned"] = Number(r.n);
    escalations = { open_by_role: byRole, open: Object.values(byRole).reduce((a, b) => a + b, 0) };
    // My queue: the console's queue per held ops role, merged by row — the same rows the legacy /api/queue answers one role at a time
    const store = new PgConsoleStore(rt.db, rt.registry, rt.agents, { fakeReviewers: rt.reviewers ? { roles: rt.reviewers.roles, delaySeconds: rt.reviewers.delaySeconds } : null });
    const merged = new Map<string, HomeQueueRow>();
    for (const role of ops) {
      for (const item of await store.queue({ role, now, ...(kind ? { kind } : {}) })) {
        const key = `${item.kind}:${item.id}`; const prior = merged.get(key);
        if (prior) { merged.set(key, { ...prior, queue_roles: [...prior.queue_roles, role] }); continue; }
        const fr = (item.detail as Record<string, unknown>)["fake_reviewer"] as HomeQueueRow["fake_reviewer"] | undefined;
        merged.set(key, { id: item.id, kind: item.kind, title: item.title, needs: item.ownerRole, held: held.includes(item.ownerRole), queue_roles: [role], loan_id: item.loanId ?? null, severity: item.severity ?? null, opened_at: item.openedAt, due_at: item.dueAt ?? null, fake_reviewer: fr ?? null, detail: item.detail });
      }
    }
    const rows = [...merged.values()].sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id));
    const by_kind: Record<QueueItem["kind"], number> = { escalation: 0, portal_task: 0, held_notice: 0, dead_letter: 0, breached_timer: 0 }; const by_role: Record<string, number> = {};
    for (const r of rows) { by_kind[r.kind]++; by_role[r.needs] = (by_role[r.needs] ?? 0) + 1; }
    my_queue = { title: "My queue", rows, count: rows.length, by_kind, by_role };
    const [c] = await rt.db.query<{ dead: string; held: string; tasks: string }>(`SELECT (SELECT count(*) FROM integration_messages WHERE status = 'dead')::text AS dead, (SELECT count(*) FROM notices WHERE status = 'held')::text AS held, (SELECT count(*) FROM human_portal_tasks WHERE status IN ('open', 'in_progress'))::text AS tasks`);
    counts = { dead_letters: Number(c?.dead ?? "0"), held_notices: Number(c?.held ?? "0"), portal_tasks: Number(c?.tasks ?? "0") };
  }
  let admin: PortalHome["admin"] = null;
  if (held.includes("admin")) {
    // the staff tiles: what 34.1 gives an admin — people and roles, the access review with its 90-day clock, the controls — nothing of a borrower
    const [staff] = await rt.db.query<{ active: string; invited: string; disabled: string }>(`SELECT count(*) FILTER (WHERE status = 'active')::text AS active, count(*) FILTER (WHERE status = 'invited')::text AS invited, count(*) FILTER (WHERE status = 'disabled')::text AS disabled FROM staff_users`);
    const review = (await rt.db.query<{ status: string; due_date: string | null; due_at: string | null }>(`SELECT status::text AS status, due_date::text AS due_date, due_at::text AS due_at FROM timers WHERE code = 'SM_STAFF_ACCESS_REVIEW_90' ORDER BY armed_at DESC LIMIT 1`))[0] ?? null;
    const lastReview = (await rt.db.query<{ reviewed_at: string }>(`SELECT reviewed_at::text AS reviewed_at FROM staff_access_reviews ORDER BY reviewed_at DESC LIMIT 1`))[0] ?? null;
    admin = { tiles: [
      { code: "staff", label: "Staff", path: "/ops/api/staff", detail: { active: Number(staff?.active ?? "0"), invited: Number(staff?.invited ?? "0"), disabled: Number(staff?.disabled ?? "0") } },
      { code: "access_review", label: "Access review", path: "/ops/api/staff/access-reviews", detail: { clock: review ? { status: review.status, due_date: review.due_date, due_at: review.due_at } : null, last_reviewed_at: lastReview?.reviewed_at ?? null } },
      { code: "controls", label: "Controls", path: "/ops/api/controls/timers", detail: { note: "clocks, escalations, the outbox, AI systems — read by every role; no count is derived here" } },
    ], other_areas: OTHER_AREAS_NEED };
  }
  return { as_of: now, acted_as: opts.acted_as, roles: held, ops_roles: ops, kind, areas, clocks, escalations, my_queue, counts, fake_reviewers: fake, admin };
}

export interface PortalLook { readonly staff_user_id: string; readonly session_id?: string | null }
/** Home on the bus's behalf: the projection plus `portal.home.viewed{staff_user_id, roles}` (global; ids and roles only). */
export async function portalHomeLogged(rt: Runtime, opts: PortalHomeOptions, look: PortalLook, actor: Actor): Promise<PortalHome & { event_id: string | null }> {
  const h = await portalHome(rt, opts);
  const w = await rt.uow.run({}, async (ctx) => { ctx.events.append({ type: "portal.home.viewed", aggregate: { kind: "staff_user", id: look.staff_user_id }, actor, payload: { staff_user_id: look.staff_user_id, ...(look.session_id ? { session_id: look.session_id } : {}), roles: h.roles, acted_as: h.acted_as, ...(h.kind ? { kind: h.kind } : {}) } }); }, { clock: rt.clock });
  return { ...h, event_id: w.events[0]?.id ?? null };
}
