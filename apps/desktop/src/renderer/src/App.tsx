import { useCallback, useEffect, useState } from "react";
import { api, STOPPABLE, type EventView, type PlanListItem, type RunnerEvent, type Snapshot } from "./api";
import { Board } from "./Board";
import { Drawer, useTerminals } from "./Drawer";
import { banner, formatLine } from "./format";
import { StatusStrip } from "./StatusStrip";
import { ReviewPanel } from "./ReviewPanel";
import { TaskPanel } from "./TaskPanel";

/** Dev/screenshot hook: `#task=T1&tab=activity` preselects a task and drawer tab. */
const initialHash = new URLSearchParams(window.location.hash.slice(1));

export function App() {
  const [repo, setRepo] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [planFile, setPlanFile] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialHash.get("task"));
  const [confirmStop, setConfirmStop] = useState(false);
  const term = useTerminals(setError);

  useEffect(() => { const tab = initialHash.get("tab"); if (tab) term.setActive(tab); }, [term.setActive]);

  const guard = useCallback(async <T,>(p: Promise<T>): Promise<T | undefined> => {
    try { setError(null); return await p; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; }
  }, []);

  const refreshPlans = useCallback(async () => {
    const list = await guard(api.call<PlanListItem[]>("plans:list"));
    if (!list) return;
    setPlans(list);
    setPlanFile((cur) => (cur && list.some((p) => p.file === cur) ? cur : list[0]?.file ?? null));
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
  useEffect(() => {
    if (!selected || !snap) return;
    const known = selected.startsWith("review:") ? snap.reviews.some((r) => `review:${r.agent}` === selected) : snap.tasks.some((t) => t.id === selected);
    if (!known) setSelected(null);
  }, [snap, selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Live engine events: agent lines into their stream tabs; everything else refreshes the board.
  useEffect(() => {
    let timer: number | undefined;
    return api.on("runner:event", (payload) => {
      const { file, event } = payload as { file: string; event: RunnerEvent };
      if (event.type === "line") {
        const text = formatLine(event.agent, event.line);
        if (text) term.write(`stream:${event.agent}`, `${text}\r\n`);
        return;
      }
      if (event.type === "task" && event.status === "working" && event.agent) {
        term.write(`stream:${event.agent}`, banner(`${event.taskId}${event.note ? ` · ${event.note}` : ""}`));
        term.followAgent(event.agent);
      }
      if (event.type === "run") term.write(`stream:${event.agent}`, `\x1b[2m${event.phase} ${event.taskId ?? ""}: ${event.outcome} · ${event.effective.toLocaleString()} effective tokens\x1b[0m\r\n`);
      if (file !== planFile) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshSnap(), 120);
    });
  }, [planFile, refreshSnap, term.write, term.followAgent]);

  const status = snap?.status ?? "not started";
  const latestReview = (snap?.reviews ?? []).filter((r, _i, all) => !all.some((x) => x.agent === r.agent && x.round > r.round));
  const blockedReviews = latestReview.filter((r) => r.decision === "request-changes");
  const task = snap?.tasks.find((t) => t.id === selected) ?? null;
  const reviewAgent = selected?.startsWith("review:") ? selected.slice(7) : null;
  const events: EventView[] = snap?.events ?? [];

  return (
    <div className="app">
      <header className="top">
        <div className="brand">harness<span>Orch</span></div>
        <button className="ghost repo" title={repo ?? ""} onClick={async () => { const r = await guard(api.call<string | null>("repo:choose")); if (r !== undefined) setRepo(r); }}>
          {repo ? repo.replaceAll("\\", "/").split("/").slice(-2).join("/") : "Open repository…"}
        </button>
        <select className="plan-select" value={planFile ?? ""} onChange={(e) => { setPlanFile(e.target.value || null); setSelected(null); }} disabled={!plans.length}>
          {!plans.length && <option value="">no plans yet</option>}
          {plans.map((p) => <option key={p.file} value={p.file}>{p.title} ({p.done}/{p.tasks}){p.errors ? " ⚠" : ""}</option>)}
        </select>
        <span className={`status-pill ${status}`}>{status}</span>
        <div className="spacer" />
        {planFile && <button className="ghost" onClick={() => void api.call("plan:open", planFile)}>Plan file</button>}
        {snap && !snap.running && !["ready", "merged"].includes(status) &&
          <button className="primary" disabled={!!snap.errors.length} onClick={() => void guard(api.call("plan:start", planFile))}>▶ Start</button>}
        {snap?.running && !confirmStop && <button onClick={() => setConfirmStop(true)}>■ Stop</button>}
        {status === "ready" && <button className="primary" onClick={async () => { if (await guard(api.call<string>("plan:merge", planFile))) void refreshSnap(); }}>Merge to {snap?.baseBranch ?? "main"}</button>}
      </header>

      {snap && <StatusStrip snap={snap} onSelectTask={setSelected} />}

      <div className="banners">
        {confirmStop && snap && (() => {
          const stoppable = snap.tasks.filter((t) => STOPPABLE.includes(t.status));
          return (
            <div className="confirm-box wide">
              <div className="confirm-title">Stop the plan?</div>
              <p className="small-text">No new tasks start.{stoppable.length
                ? <> These get killed now and their uncommitted edits parked on the stash: {stoppable.map((t) => `${t.id} (${t.assigned ?? "?"}, ${t.status})`).join(", ")}.</>
                : " Nothing is mid-turn right now."}{stoppable.some((t) => t.status === "merging") ? " A merge in progress finishes first." : ""} Reviews and orchestrator turns finish on their own.
                Stopped tasks wait under Needs you: Resume, Restart clean or Skip.</p>
              <div className="row">
                <button className="ghost small" onClick={() => setConfirmStop(false)}>Keep running</button>
                <button className="danger small" onClick={() => { setConfirmStop(false); void guard(api.call("plan:stopAll", planFile)); }}>Stop all</button>
              </div>
            </div>
          );
        })()}
        {error && <div className="banner error" onClick={() => setError(null)}>{error} <span className="muted">(click to dismiss)</span></div>}
        {snap?.errors.map((e) => <div key={e} className="banner error">Plan error: {e}</div>)}
        {snap?.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
      </div>

      <main className={task || reviewAgent ? "with-panel" : ""}>
        {snap ? (
          <Board snap={snap} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
            blockedReviews={blockedReviews} onReview={(agent, action) => void guard(api.call("plan:review", planFile, agent, action))} />
        ) : (
          <div className="empty">
            {repo
              ? <><p>No plan yet.</p><p className="muted">Open <b>Planner · Opus</b> below and plan with Opus; the plan appears here when it writes <code>.harness/plans/*.md</code>.</p></>
              : <><p>Open a git repository to start.</p><button className="primary" onClick={async () => { const r = await guard(api.call<string | null>("repo:choose")); if (r !== undefined) setRepo(r); }}>Open repository…</button></>}
          </div>
        )}
        {task && snap && planFile &&
          <TaskPanel snap={snap} task={task} planFile={planFile} initialTab={initialHash.get("ptab")} onClose={() => setSelected(null)} onError={setError} onChanged={refreshSnap} />}
        {reviewAgent && snap && planFile &&
          <ReviewPanel snap={snap} agent={reviewAgent} planFile={planFile} onClose={() => setSelected(null)} onSelectTask={setSelected}
            onReview={async (action) => { if (await guard(api.call("plan:review", planFile, reviewAgent, action)) !== undefined) { setSelected(null); void refreshSnap(); } }} />}
      </main>

      <Drawer term={term} snap={snap} events={events} repo={repo} planFile={planFile} blockedReviews={blockedReviews.length} />
    </div>
  );
}
