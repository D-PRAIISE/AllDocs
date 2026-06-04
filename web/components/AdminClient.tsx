"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminStats {
  visitors_all_time: number;
  visitors_today: number;
  imports_total: number;
  exports_total: number;
  reports_total: number;
  rate_limited_total: number;
  rejected_total: number;
  exports_by_format: Record<string, number>;
  series: { date: string; imports: number; visitors: number }[];
}

interface Ticket {
  id: string;
  received_at: string | null;
  session_id: string | null;
  user_agent: string | null;
  source_filename: string | null;
  description: string;
  attachments: { name: string; size: number }[];
}

type AuthState = "checking" | "out" | "in" | "disabled";

export function AdminClient() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [openTicket, setOpenTicket] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const [s, t] = await Promise.all([
      fetch("/api/admin/stats"),
      fetch("/api/admin/tickets"),
    ]);
    if (s.status === 401 || t.status === 401) {
      setAuth("out");
      return;
    }
    if (s.status === 503) {
      setAuth("disabled");
      return;
    }
    if (s.ok) setStats(await s.json());
    if (t.ok) setTickets((await t.json()).tickets);
    setAuth("in");
  }, []);

  useEffect(() => {
    // Probe auth on mount — a valid cookie loads straight into the
    // dashboard; otherwise we drop to the login form.
    loadData().catch(() => setAuth("out"));
  }, [loadData]);

  const login = async () => {
    setLoginError(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.status === 503) {
      setAuth("disabled");
      return;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setLoginError(j?.error ?? `HTTP ${res.status}`);
      return;
    }
    setPassword("");
    await loadData();
  };

  const logout = async () => {
    await fetch("/api/admin/login", { method: "DELETE" });
    setStats(null);
    setTickets(null);
    setAuth("out");
  };

  if (auth === "checking") {
    return <Shell><div className="label">checking…</div></Shell>;
  }

  if (auth === "disabled") {
    return (
      <Shell>
        <div className="font-mono text-xs text-warn leading-relaxed max-w-md">
          Admin is not configured on this instance. Set the{" "}
          <span className="text-fg">ALLDOCS_ADMIN_PASSWORD</span> environment
          variable on the server and restart the service.
        </div>
      </Shell>
    );
  }

  if (auth === "out") {
    return (
      <Shell>
        <div className="max-w-sm space-y-3">
          <div className="label">admin login</div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="admin password"
            autoFocus
            className="w-full px-3 py-2 border border-border bg-input font-mono text-sm"
            style={{ color: "#111", caretColor: "#111", background: "#fff" }}
          />
          {loginError && (
            <div className="font-mono text-xs text-error">{loginError}</div>
          )}
          <button onClick={login} className="btn-primary" disabled={!password}>
            sign in
          </button>
        </div>
      </Shell>
    );
  }

  // auth === "in"
  return (
    <Shell onLogout={logout}>
      {stats && <StatsGrid stats={stats} />}
      {stats && stats.series.length > 0 && <Series series={stats.series} />}
      <TicketList
        tickets={tickets ?? []}
        open={openTicket}
        onToggle={(id) => setOpenTicket((cur) => (cur === id ? null : id))}
      />
    </Shell>
  );
}

function Shell({
  children,
  onLogout,
}: {
  children: React.ReactNode;
  onLogout?: () => void;
}) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="font-mono text-xl font-bold uppercase tracking-tight">
          AllDocs · admin
        </h1>
        {onLogout && (
          <button
            onClick={onLogout}
            className="font-mono text-xs uppercase tracking-wider text-muted hover:text-fg"
          >
            sign out
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function StatsGrid({ stats }: { stats: AdminStats }) {
  const cards: { label: string; value: number | string }[] = [
    { label: "visitors (all time)", value: stats.visitors_all_time },
    { label: "visitors (today)", value: stats.visitors_today },
    { label: "documents imported", value: stats.imports_total },
    { label: "documents exported", value: stats.exports_total },
    { label: "bug reports", value: stats.reports_total },
    { label: "rate-limited hits", value: stats.rate_limited_total },
  ];
  return (
    <section>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border border border-border">
        {cards.map((c) => (
          <div key={c.label} className="bg-surface p-4">
            <div className="font-sans text-2xl font-bold tabular-nums text-fg">
              {c.value}
            </div>
            <div className="mt-1 label">{c.label}</div>
          </div>
        ))}
      </div>
      {Object.keys(stats.exports_by_format).length > 0 && (
        <div className="mt-3 font-mono text-xs text-muted">
          exports by format:{" "}
          {Object.entries(stats.exports_by_format)
            .sort((a, b) => b[1] - a[1])
            .map(([f, n]) => `${f} ${n}`)
            .join(" · ")}
        </div>
      )}
    </section>
  );
}

function Series({ series }: { series: AdminStats["series"] }) {
  const max = Math.max(1, ...series.map((s) => s.imports));
  return (
    <section className="border border-border bg-surface p-4">
      <div className="label mb-3">imports · last {series.length} days</div>
      <div className="flex items-end gap-1" style={{ height: 80 }}>
        {series.map((s) => (
          <div
            key={s.date}
            className="flex-1 bg-accent/70 hover:bg-accent transition-colors"
            style={{ height: `${(s.imports / max) * 100}%`, minHeight: 1 }}
            title={`${s.date}: ${s.imports} imports, ${s.visitors} visitors`}
          />
        ))}
      </div>
    </section>
  );
}

function TicketList({
  tickets,
  open,
  onToggle,
}: {
  tickets: Ticket[];
  open: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <section>
      <div className="label mb-3">bug reports · {tickets.length}</div>
      {tickets.length === 0 ? (
        <div className="font-mono text-xs text-muted border border-border bg-surface p-4">
          no tickets yet
        </div>
      ) : (
        <div className="border border-border bg-surface divide-y divide-border">
          {tickets.map((t) => (
            <div key={t.id}>
              <button
                onClick={() => onToggle(t.id)}
                className="w-full text-left px-4 py-3 hover:bg-elevated transition-colors flex items-center justify-between gap-3"
              >
                <span className="font-mono text-xs text-fg truncate">
                  {t.description.slice(0, 80) || "(no description)"}
                </span>
                <span className="font-mono text-[0.65rem] text-subtle whitespace-nowrap">
                  {t.received_at ? new Date(t.received_at).toLocaleString() : t.id.slice(0, 8)}
                </span>
              </button>
              {open === t.id && (
                <div className="px-4 pb-4 space-y-3 bg-elevated/40">
                  <pre className="font-mono text-xs text-fg whitespace-pre-wrap leading-relaxed">
                    {t.description || "(no description)"}
                  </pre>
                  <div className="font-mono text-[0.65rem] text-subtle space-y-0.5">
                    <div>ticket: {t.id}</div>
                    {t.session_id && <div>session: {t.session_id}</div>}
                    {t.source_filename && <div>file: {t.source_filename}</div>}
                    {t.user_agent && <div className="truncate">ua: {t.user_agent}</div>}
                  </div>
                  {t.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {t.attachments.map((a) => (
                        <a
                          key={a.name}
                          href={`/api/admin/tickets/${t.id}/file/${a.name}`}
                          className="font-mono text-xs px-2 py-1 border border-border text-accent hover:border-accent"
                        >
                          ↓ {a.name} ({formatBytes(a.size)})
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
