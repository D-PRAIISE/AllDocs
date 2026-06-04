"use client";

import { useCallback, useEffect, useState } from "react";

interface WindowCounts {
  visitors: number;
  imports: number;
  exports: number;
}

interface AdminStats {
  windows: Record<string, WindowCounts>;
  funnel: {
    landing_visitors: number;
    editor_visitors: number;
    imports: number;
    conversion_pct: number;
  };
  formats: { imports: Record<string, number>; exports: Record<string, number> };
  performance: { avg_import_ms: number; avg_export_ms: number };
  totals: {
    bytes_processed: number;
    reports: number;
    rate_limited: number;
    rejected: number;
    error_rate_pct: number;
  };
  series: { date: string; imports: number; exports: number; visitors: number }[];
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
      {stats && <Funnel funnel={stats.funnel} />}
      {stats && <StatsGrid stats={stats} />}
      {stats && stats.series.length > 0 && <Series series={stats.series} />}
      {stats && <Formats formats={stats.formats} />}
      {stats && <HealthLine stats={stats} />}
      <TicketList
        tickets={tickets ?? []}
        open={openTicket}
        onToggle={(id) => setOpenTicket((cur) => (cur === id ? null : id))}
      />
    </Shell>
  );
}

function Funnel({ funnel }: { funnel: AdminStats["funnel"] }) {
  const steps: { label: string; value: number }[] = [
    { label: "landing visitors", value: funnel.landing_visitors },
    { label: "opened editor", value: funnel.editor_visitors },
    { label: "imported a doc", value: funnel.imports },
  ];
  return (
    <section className="space-y-3">
      <div className="label">funnel · all time</div>
      <div className="grid grid-cols-3 gap-px bg-border border border-border">
        {steps.map((s) => (
          <div key={s.label} className="bg-surface p-4 text-center">
            <div className="font-sans text-3xl font-bold tabular-nums text-fg">
              {s.value}
            </div>
            <div className="mt-1 label">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="font-mono text-xs text-muted">
        conversion (landing → imported):{" "}
        <span className="text-accent font-semibold">{funnel.conversion_pct}%</span>
      </div>
    </section>
  );
}

function Formats({ formats }: { formats: AdminStats["formats"] }) {
  const entries = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]);
  const imp = entries(formats.imports);
  const exp = entries(formats.exports);
  if (imp.length === 0 && exp.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="label">by format</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormatList title="imported" rows={imp} />
        <FormatList title="exported" rows={exp} />
      </div>
    </section>
  );
}

function FormatList({ title, rows }: { title: string; rows: [string, number][] }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <div className="border border-border bg-surface p-4">
      <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted mb-2">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-xs text-subtle">—</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(([fmt, n]) => (
            <div key={fmt} className="flex items-center gap-2">
              <div className="font-mono text-xs text-fg w-14 shrink-0">{fmt}</div>
              <div className="flex-1 bg-border/40 h-3">
                <div
                  className="h-3 bg-accent/80"
                  style={{ width: `${(n / max) * 100}%` }}
                />
              </div>
              <div className="font-mono text-xs text-muted tabular-nums w-8 text-right">
                {n}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthLine({ stats }: { stats: AdminStats }) {
  const cards: { label: string; value: string }[] = [
    { label: "avg import time", value: `${stats.performance.avg_import_ms} ms` },
    { label: "avg export time", value: `${stats.performance.avg_export_ms} ms` },
    { label: "data processed", value: formatBytes(stats.totals.bytes_processed) },
    { label: "bug reports", value: String(stats.totals.reports) },
    { label: "rate-limited", value: String(stats.totals.rate_limited) },
    { label: "error rate", value: `${stats.totals.error_rate_pct}%` },
  ];
  return (
    <section className="space-y-3">
      <div className="label">performance &amp; health</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border border border-border">
        {cards.map((c) => (
          <div key={c.label} className="bg-surface p-4">
            <div className="font-sans text-lg font-bold tabular-nums text-fg">
              {c.value}
            </div>
            <div className="mt-1 label">{c.label}</div>
          </div>
        ))}
      </div>
    </section>
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

const WINDOW_ROWS: { key: string; label: string }[] = [
  { key: "hour", label: "past hour" },
  { key: "day", label: "past 24 hours" },
  { key: "week", label: "past 7 days" },
  { key: "month", label: "past 30 days" },
  { key: "year", label: "past year" },
  { key: "all", label: "all time" },
];

function StatsGrid({ stats }: { stats: AdminStats }) {
  const w = stats.windows ?? {};
  return (
    <section className="space-y-3">
      <div className="label">activity by time window</div>
      <div className="border border-border bg-surface overflow-x-auto">
        <table className="w-full font-mono text-sm">
          <thead>
            <tr className="border-b border-border bg-elevated text-left">
              <th className="px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted">
                window
              </th>
              <th className="px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted text-right">
                visitors
              </th>
              <th className="px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted text-right">
                imported
              </th>
              <th className="px-4 py-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted text-right">
                exported
              </th>
            </tr>
          </thead>
          <tbody>
            {WINDOW_ROWS.map((row, i) => {
              const c = w[row.key] ?? { visitors: 0, imports: 0, exports: 0 };
              return (
                <tr key={row.key} className={i % 2 ? "" : "bg-bg/30"}>
                  <td className="px-4 py-2 text-fg/85">{row.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg font-semibold">
                    {c.visitors}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg">{c.imports}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-fg">{c.exports}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Series({ series }: { series: AdminStats["series"] }) {
  // Shared scale across imports + visitors so the two bars are
  // comparable day to day.
  const max = Math.max(1, ...series.flatMap((s) => [s.imports, s.visitors]));
  const showLabels = series.length <= 14;
  const CHART_H = 90;
  const VISITOR_COLOR = "#5b9bd5"; // same blue used for selection in the editor
  return (
    <section className="border border-border bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="label">per day · last {series.length}</div>
        <div className="flex items-center gap-3 font-mono text-[0.6rem] uppercase tracking-wider">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 bg-accent/80" /> imports
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3" style={{ background: VISITOR_COLOR }} /> visitors
          </span>
        </div>
      </div>
      {/* Two thin bars per day (imports + visitors) in a shared faint
          track. Fixed widths so a few days read as a few bars, not a
          full-width slab. Labels live ABOVE the track in a reserved row
          so they never overlap the heading or the bars. */}
      <div className="flex items-end gap-2 overflow-x-auto pt-1">
        {series.map((s) => (
          <div
            key={s.date}
            className="flex flex-col items-center shrink-0"
            style={{ width: 34 }}
            title={`${s.date} — imports: ${s.imports}, exports: ${s.exports}, visitors: ${s.visitors}`}
          >
            {showLabels && (
              <div className="font-mono text-[0.55rem] text-muted tabular-nums mb-1 h-3 leading-3">
                {s.imports}/{s.visitors}
              </div>
            )}
            <div className="w-full bg-border/40 flex items-end justify-center gap-0.5" style={{ height: CHART_H }}>
              <div
                className="bg-accent/80 hover:bg-accent transition-colors"
                style={{
                  width: 12,
                  height: `${(s.imports / max) * 100}%`,
                  minHeight: s.imports > 0 ? 2 : 0,
                }}
              />
              <div
                className="transition-opacity hover:opacity-100 opacity-90"
                style={{
                  width: 12,
                  background: VISITOR_COLOR,
                  height: `${(s.visitors / max) * 100}%`,
                  minHeight: s.visitors > 0 ? 2 : 0,
                }}
              />
            </div>
            {showLabels && (
              <div className="font-mono text-[0.55rem] text-subtle mt-1">
                {s.date.slice(5)}
              </div>
            )}
          </div>
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
