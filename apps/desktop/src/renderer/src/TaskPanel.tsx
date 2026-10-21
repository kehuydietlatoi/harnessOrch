import { useEffect, useState } from "react";
import { ActivityList } from "./Activity";
import { DiffView } from "./Diff";
import { AGENTS, api, fmtDuration, fmtTime, fmtTokens, prefs, type Snapshot, type TaskView } from "./api";

type Tab = "overview" | "activity" | "diff" | "tokens";

/** Everything about one task, beside the board. */
export function TaskPanel(props: {
  snap: Snapshot;
  task: TaskView;
  planFile: string;
  initialTab?: string | null;
  onClose: () => void;
  onError: (e: string) => void;
  onChanged: () => void;
}) {
  const t = props.task;
  const [tab, setTab] = useState<Tab>(() => (props.initialTab as Tab | undefined) ?? (t.status === "paused" ? "activity" : prefs.get<Tab>("panelTab", "overview")));
  const [diff, setDiff] = useState<string | null>(null);
  const commitsKey = t.commits.join(",");

  useEffect(() => { prefs.set("panelTab", tab); }, [tab]);
  useEffect(() => { setDiff(null); }, [t.id, commitsKey]);
  useEffect(() => {
    if (tab !== "diff" || diff !== null) return;
    api.call<string>("plan:taskDiff", props.planFile, t.id).then(setDiff, (e: Error) => setDiff(`Could not load diff: ${e.message}`));
  }, [tab, diff, props.planFile, t.id]);

  const runs = props.snap.runs.filter((r) => r.taskId === t.id);
  const tokens = runs.reduce((n, r) => n + r.effective, 0);
  const call = (p: Promise<unknown>) => p.then(props.onChanged, (e: Error) => props.onError(e.message));

  return (
    <aside className="panel">
      <header className="panel-head">
        <div>
          <div className="panel-id"><b>{t.id}</b> <span className={`badge role-${t.role}`}>{t.role}</span> <span className={`status-pill ${t.status}`}>{t.status}</span></div>
          <h2>{t.title}</h2>
        </div>
        <button className="ghost icon" onClick={props.onClose} title="Close (Esc)">×</button>
      </header>

      {t.status === "paused" && <ResumeBox task={t} onResume={(guidance, agent) => call(api.call("plan:resume", props.planFile, t.id, guidance, agent))} />}

      <nav className="panel-tabs">
        {(["overview", "activity", "diff", "tokens"] as Tab[]).map((x) => (
          <button key={x} className={tab === x ? "active" : ""} onClick={() => setTab(x)}>
            {x === "tokens" ? `Tokens · ${fmtTokens(tokens)}` : x === "diff" ? `Diff${t.commits.length ? ` · ${t.commits.length}` : ""}` : x[0].toUpperCase() + x.slice(1)}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {tab === "overview" && (
          <div className="overview">
            <Field label="Agent">
              <select value={t.agent ?? ""} disabled={t.status !== "pending"}
                onChange={(e) => void call(api.call("plan:setAgent", props.planFile, t.id, e.target.value || null))}>
                <option value="">{t.assigned ? `${t.assigned} (auto)` : "auto"}</option>
                {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {t.status !== "pending" && <span className="muted"> locked while {t.status}</span>}
            </Field>
            <Field label="Goal"><p>{t.goal}</p></Field>
            {t.summary && <Field label="Result"><p>{t.summary}</p></Field>}
            {t.doneWhen.length > 0 && <Field label="Done when"><List items={t.doneWhen} /></Field>}
            <Field label="Checks"><List items={t.checks.length ? t.checks : props.snap.checks.map((c) => `${c} (plan)`)} code /></Field>
            <Field label="Write scope"><List items={t.writeScope} code /></Field>
            {t.readFirst.length > 0 && <Field label="Read first"><List items={t.readFirst} code /></Field>}
            {t.dependsOn.length > 0 && <Field label="Depends on"><p>{t.dependsOn.join(", ")}</p></Field>}
            {t.skills.length > 0 && <Field label="Skills"><p>{t.skills.join(", ")}</p></Field>}
            {t.decisions.length > 0 && <Field label="Decisions"><List items={t.decisions} /></Field>}
          </div>
        )}
        {tab === "activity" && <ActivityList events={props.snap.events} filterTask={t.id} newestFirst />}
        {tab === "diff" && (diff === null ? <div className="muted pad">Loading…</div> : <DiffView diff={diff} />)}
        {tab === "tokens" && (
          runs.length === 0 ? <div className="muted pad">No runs yet.</div> : (
            <table className="runs">
              <thead><tr><th>Time</th><th>Agent</th><th>Phase</th><th>Outcome</th><th>Effective</th><th>Cache</th><th>Took</th><th /></tr></thead>
              <tbody>
                {runs.map((r, i) => {
                  const total = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
                  return (
                    <tr key={i}>
                      <td>{fmtTime(r.ts)}</td><td className={r.agent}>{r.agent}</td><td>{r.phase}</td>
                      <td className={r.outcome === "done" ? "ok" : "err"}>{r.outcome}</td>
                      <td>{fmtTokens(r.effective)}</td><td>{total ? `${Math.round((r.usage.cacheRead / total) * 100)}%` : "—"}</td>
                      <td>{r.durationMs ? fmtDuration(r.durationMs) : "—"}</td>
                      <td>{r.logFile && <a onClick={() => void api.call("log:open", r.logFile)}>log</a>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
      </div>
    </aside>
  );
}

function ResumeBox(props: { task: TaskView; onResume: (guidance: string | null, agent: string | null) => void }) {
  const [guidance, setGuidance] = useState("");
  const [agent, setAgent] = useState("");
  return (
    <div className="resume-box">
      <div className="resume-title">⏸ This task needs you</div>
      {props.task.note && <p className="note">{props.task.note}</p>}
      <textarea placeholder="Your answer or guidance for the agent (optional)" value={guidance} onChange={(e) => setGuidance(e.target.value)} />
      <div className="row">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} title="Run it on">
          <option value="">same agent (keeps its work)</option>
          {AGENTS.filter((a) => a !== props.task.assigned).map((a) => <option key={a} value={a}>{a} (starts fresh)</option>)}
        </select>
        <button className="primary" onClick={() => props.onResume(guidance || null, agent || null)}>Resume</button>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return <div className="field"><div className="label">{props.label}</div><div>{props.children}</div></div>;
}

function List(props: { items: string[]; code?: boolean }) {
  return <ul className="plain">{props.items.map((i) => <li key={i}>{props.code ? <code>{i}</code> : i}</li>)}</ul>;
}
