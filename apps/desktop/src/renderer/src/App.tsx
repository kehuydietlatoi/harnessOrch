import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, api, type Agent, type PlanListItem, type RunnerEvent, type Snapshot, type TaskView } from "./api";
import { banner, formatLine } from "./format";
import { Term, type TermHandle } from "./Term";

type Tab = { key: string; label: string; kind: "planner" | "stream" | "takeover"; agent?: Agent; ptyId?: string; exited?: boolean };

const COLUMNS: Array<{ status: TaskView["status"]; label: string }> = [
  { status: "pending", label: "Planned" },
  { status: "running", label: "Running" },
  { status: "paused", label: "Needs you" },
  { status: "done", label: "Done" },
];

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [planFile, setPlanFile] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([
    { key: "planner", label: "Planner · Opus", kind: "planner" },
    ...AGENTS.map((a) => ({ key: `stream:${a}`, label: a, kind: "stream" as const, agent: a })),
  ]);
  const [active, setActive] = useState("planner");
  const handles = useRef(new Map<string, TermHandle>());
  const pending = useRef(new Map<string, string[]>());
  const ptyToTab = useRef(new Map<string, string>());
  const plannerLive = useRef(false);

  const write = useCallback((key: string, data: string) => {
    const h = handles.current.get(key);
    if (h) h.write(data);
    else pending.current.set(key, [...(pending.current.get(key) ?? []), data]);
  }, []);

  const guard = useCallback(async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try { setError(null); return await p; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; }
  }, []);

  const refreshPlans = useCallback(async () => {
    const list = await guard(api.call<PlanListItem[]>("plans:list"));
    if (!list) return;
    setPlans(list);
    setPlanFile((cur) => cur && list.some((p) => p.file === cur) ? cur : list[0]?.file ?? null);
  }, [guard]);

  const refreshSnap = useCallback(async () => {
    if (!planFile) { setSnap(null); return; }
    const s = await api.call<Snapshot>("plan:snapshot", planFile).catch((e: Error) => { setError(e.message); return null; });
    if (s) setSnap(s);
  }, [planFile]);

  useEffect(() => { void api.call<string | null>("repo:get").then(setRepo); }, []);
  useEffect(() => { if (repo) void refreshPlans(); }, [repo, refreshPlans]);
  useEffect(() => { void refreshSnap(); }, [refreshSnap]);
  useEffect(() => api.on("plans:changed", () => { void refreshPlans(); void refreshSnap(); }), [refreshPlans, refreshSnap]);

  // Live engine events: agent lines into their stream tabs, everything else refreshes the board.
  useEffect(() => {
    let timer: number | undefined;
    return api.on("runner:event", (payload) => {
      const { file, event } = payload as { file: string; event: RunnerEvent };
      if (event.type === "line") {
        const text = formatLine(event.agent, event.line);
        if (text) write(`stream:${event.agent}`, `${text}\r\n`);
        return;
      }
      if (event.type === "task" && event.status === "running" && event.agent) {
        write(`stream:${event.agent}`, banner(`${event.taskId}${event.note ? ` · ${event.note}` : ""}`));
        // Nothing to type into yet: show the agent that just started instead of an idle planner tab.
        const agentTab = `stream:${event.agent}`;
        setActive((cur) => (cur === "planner" && !plannerLive.current ? agentTab : cur));
      }
      if (event.type === "run") write(`stream:${event.agent}`, `\x1b[2m${event.phase} ${event.taskId ?? ""}: ${event.outcome} · ${event.effective.toLocaleString()} effective tokens\x1b[0m\r\n`);
      if (file !== planFile) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void refreshSnap(), 120);
    });
  }, [planFile, refreshSnap, write]);

  useEffect(() => {
    const offData = api.on("pty:data", (p) => {
      const { id, data } = p as { id: string; data: string };
      const key = ptyToTab.current.get(id);
      if (key) write(key, data);
    });
    const offExit = api.on("pty:exit", (p) => {
      const { id } = p as { id: string };
      const key = ptyToTab.current.get(id);
      if (!key) return;
      if (key === "planner") plannerLive.current = false;
      write(key, "\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, exited: true, ptyId: undefined } : t)));
      void refreshSnap();
    });
    return () => { offData(); offExit(); };
  }, [write, refreshSnap]);

  const onReady = (key: string) => (h: TermHandle) => {
    handles.current.set(key, h);
    for (const d of pending.current.get(key) ?? []) h.write(d);
    pending.current.delete(key);
  };

  const startPlanner = async () => {
    const h = handles.current.get("planner");
    const id = await guard(api.call<string>("pty:planner", h?.term.cols ?? 120, h?.term.rows ?? 30));
    if (!id) return;
    ptyToTab.current.set(id, "planner");
    plannerLive.current = true;
    setTabs((ts) => ts.map((t) => (t.key === "planner" ? { ...t, ptyId: id, exited: false } : t)));
    setActive("planner");
    h?.term.focus();
  };

  const takeOver = async (agent: Agent) => {
    if (!planFile) return;
    const key = `takeover:${agent}`;
    const h = handles.current.get(`stream:${agent}`);
    const id = await guard(api.call<string>("pty:takeover", planFile, agent, h?.term.cols ?? 120, h?.term.rows ?? 30));
    if (!id) return;
    ptyToTab.current.set(id, key);
    setTabs((ts) => [...ts.filter((t) => t.key !== key), { key, label: `${agent} · you`, kind: "takeover", agent, ptyId: id }]);
    setActive(key);
  };

  const closeTab = (t: Tab) => {
    if (t.ptyId) void api.call("pty:kill", t.ptyId);
    if (t.kind === "takeover") {
      setTabs((ts) => ts.filter((x) => x.key !== t.key));
      setActive(`stream:${t.agent}`);
    }
  };

  const tasksBy = useMemo(() => {
    const m = new Map<string, TaskView[]>();
    for (const t of snap?.tasks ?? []) m.set(t.status, [...(m.get(t.status) ?? []), t]);
    return m;
  }, [snap]);

  const totalEffective = snap?.agents.reduce((n, a) => n + a.effective, 0) ?? 0;
  const doneCount = snap?.tasks.filter((t) => t.status === "done").length ?? 0;
  const blockedReviews = (snap?.reviews ?? []).filter((r, i, all) => r.decision === "request-changes" && !all.some((x) => x.agent === r.agent && x.round > r.round));
  const status = snap?.status ?? "not started";

  return (
    <div className="app">
      <header>
        <div className="brand">harnessOrch</div>
        <button className="ghost" onClick={async () => { const r = await guard(api.call<string | null>("repo:choose")); if (r !== undefined) setRepo(r); }}>
          {repo ?? "Open repository…"}
        </button>
        <select value={planFile ?? ""} onChange={(e) => setPlanFile(e.target.value || null)} disabled={!plans.length}>
          {!plans.length && <option value="">no plans yet — plan with Opus →</option>}
          {plans.map((p) => <option key={p.file} value={p.file}>{p.title} ({p.done}/{p.tasks}){p.errors ? " ⚠" : ""}</option>)}
        </select>
        <span className={`pill ${status}`}>{status}</span>
        <div className="spacer" />
        {planFile && <button className="ghost" onClick={() => void api.call("plan:open", planFile)}>Open plan file</button>}
        {snap && !snap.running && status !== "ready" && status !== "merged" &&
          <button className="primary" disabled={!!snap.errors.length} onClick={() => void guard(api.call("plan:start", planFile))}>Start</button>}
        {snap?.running && <button onClick={() => void guard(api.call("plan:stop", planFile))}>Stop</button>}
        {status === "ready" && <button className="primary" onClick={async () => { const sha = await guard(api.call<string>("plan:merge", planFile)); if (sha) void refreshSnap(); }}>Merge to main</button>}
      </header>

      <div className="banners">
        {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
        {snap?.errors.map((e) => <div key={e} className="banner error">Plan error: {e}</div>)}
        {snap?.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
      </div>

      <main>
        <section className="board">
          {COLUMNS.map((col) => (
            <div key={col.status} className={`column ${col.status}`}>
              <h3>{col.label} <span>{tasksBy.get(col.status)?.length ?? 0}</span></h3>
              {(tasksBy.get(col.status) ?? []).map((t) => (
                <TaskCard key={t.id} task={t} planFile={planFile!} onError={setError} onChanged={refreshSnap} />
              ))}
              {col.status === "paused" && blockedReviews.map((r) => (
                <div key={r.agent} className="card review">
                  <div className="card-head"><b>Review of {r.agent}</b><span className="badge">round {r.round}</span></div>
                  <p className="note">{r.notes}</p>
                  <div className="row">
                    <button onClick={() => void guard(api.call("plan:review", planFile, r.agent, "approve"))}>Approve anyway</button>
                    <button onClick={() => void guard(api.call("plan:review", planFile, r.agent, "retry"))}>Review again</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {!snap && <div className="empty">{repo ? "Plan with Opus in the terminal, or add a plan to .harness/plans/." : "Open a git repository to start."}</div>}
        </section>

        <section className="terminals">
          <nav>
            {tabs.map((t) => (
              <div key={t.key} className={`tab ${active === t.key ? "active" : ""} ${t.agent ?? ""}`} onClick={() => setActive(t.key)}>
                {t.agent && snap?.agents.find((a) => a.agent === t.agent)?.active && <span className="dot" />}
                {t.label}
                {t.kind === "takeover" && <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(t); }}>Hand back ×</span>}
              </div>
            ))}
            <div className="spacer" />
            {active === "planner" && !tabs.find((t) => t.key === "planner")?.ptyId &&
              <button className="primary small" disabled={!repo} onClick={() => void startPlanner()}>Start planning session</button>}
            {active.startsWith("stream:") && planFile &&
              <button className="small" onClick={() => void takeOver(active.slice(7) as Agent)}>Take over</button>}
          </nav>
          <div className="term-host">
            {tabs.map((t) => (
              <Term key={t.key} visible={active === t.key} onReady={onReady(t.key)}
                onInput={t.kind === "stream" ? undefined : (d) => { const id = tabs.find((x) => x.key === t.key)?.ptyId; if (id) void api.call("pty:write", id, d); }}
                onResize={(cols, rows) => { const id = tabs.find((x) => x.key === t.key)?.ptyId; if (id) void api.call("pty:resize", id, cols, rows); }} />
            ))}
          </div>
        </section>
      </main>

      <footer>
        {(snap?.agents ?? AGENTS.map((agent) => ({ agent, runs: 0, effective: 0, cacheHit: null, active: false }))).map((a) => (
          <div key={a.agent} className={`meter ${a.agent}`}>
            <b>{a.agent}</b> {fmt(a.effective)} <span>effective · {a.runs} runs · cache {a.cacheHit === null ? "—" : `${Math.round(a.cacheHit * 100)}%`}</span>
          </div>
        ))}
        <div className="meter total"><b>total</b> {fmt(totalEffective)}{doneCount ? <span> · {fmt(Math.round(totalEffective / doneCount))} per done task</span> : null}</div>
      </footer>
    </div>
  );
}

function TaskCard(props: { task: TaskView; planFile: string; onError: (e: string) => void; onChanged: () => void }) {
  const t = props.task;
  const [guidance, setGuidance] = useState("");
  const [agent, setAgent] = useState<string>("");
  const editable = t.status === "pending";
  const call = (p: Promise<unknown>) => p.then(props.onChanged, (e: Error) => props.onError(e.message));
  return (
    <div className={`card ${t.assigned ?? ""}`}>
      <div className="card-head">
        <b>{t.id}</b>
        <span className={`badge role-${t.role}`}>{t.role}</span>
        <select value={t.agent ?? ""} disabled={!editable} title="Agent"
          onChange={(e) => void call(api.call("plan:setAgent", props.planFile, t.id, e.target.value || null))}>
          <option value="">{!t.agent && t.assigned ? `${t.assigned} (auto)` : "auto"}</option>
          {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="title">{t.title}</div>
      {t.dependsOn.length > 0 && <div className="deps">after {t.dependsOn.join(", ")}</div>}
      {t.attempts > 0 && t.status !== "done" && <div className="deps">attempt {t.attempts + 1}</div>}
      {t.note && <p className="note">{t.note}</p>}
      {t.status === "paused" && (
        <div className="resume">
          <textarea placeholder="Answer or guidance for the agent (optional)" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
          <div className="row">
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">same agent</option>
              {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button className="primary" onClick={() => void call(api.call("plan:resume", props.planFile, t.id, guidance || null, agent || null))}>Resume</button>
          </div>
        </div>
      )}
    </div>
  );
}
