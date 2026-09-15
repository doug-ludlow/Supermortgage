"use client";

/** P0 mobile chrome: five tabs. Composer stays on Chat. */
export type TabId = "apply" | "chat" | "loan" | "tasks" | "account";

const TABS: { id: TabId; label: string; testid: string }[] = [
  { id: "apply", label: "Apply", testid: "tab-apply" },
  { id: "chat", label: "Chat", testid: "tab-chat" },
  { id: "loan", label: "My Loan", testid: "tab-loan" },
  { id: "tasks", label: "Tasks", testid: "tab-tasks" },
  { id: "account", label: "Account", testid: "tab-account" },
];

export function BottomNav({
  tab,
  onTab,
  taskCount,
}: {
  tab: TabId;
  onTab: (id: TabId) => void;
  taskCount: number;
}) {
  return (
    <nav className="sm-tab-nav" aria-label="App" data-testid="tab-nav">
      {TABS.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            className="sm-tab-btn"
            data-testid={t.testid}
            data-active={active ? "true" : "false"}
            aria-current={active ? "page" : undefined}
            onClick={() => onTab(t.id)}
          >
            <span className="sm-tab-label">{t.label}</span>
            {t.id === "tasks" && taskCount > 0 ? (
              <span className="sm-tab-badge" aria-label={`${taskCount} needed from you`}>
                {taskCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
