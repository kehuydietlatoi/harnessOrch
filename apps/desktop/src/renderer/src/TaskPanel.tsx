import { useEffect, useState } from "react";
import { ActivityList } from "./Activity";
import { DiffView } from "./Diff";
import { AGENTS, EFFORTS, api, fmtDuration, fmtTime, fmtTokens, groupOf, NEEDS_YOU, prefs, STOPPABLE, type Snapshot, type StopInfo, type TaskView } from "./api";

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
  const [tab, setTab] = useState<Tab>(() => (props.initialTab as Tab | undefined) ?? (NEEDS_YOU.includes(t.status) ? "activity" : prefs.get<Tab>("panelTab", "overview")));
  const [diff, setDiff] = useState<string | null>(null);
  const commitsKey = t.commits.join(",");

  useEffect(() => { prefs.set("panelTab", tab); }, [tab]);
  useEffect(() => { setDiff(null); }, [t.id, commitsKey]);
  useEffect(() => {
    if (tab !== "diff" || diff !== null) return;
    api.call<string>("plan:taskDiff", props.planFile, t.id).then(setDiff, (e: Error) => setDiff(`Could not load diff: ${e.message}`));
  }, [tab, diff, props.planFile, t.id]);

  const editable = t.status === "queued" || NEEDS_YOU.includes(t.status);
  const runs = props.snap.runs.filter((r) => r.taskId === t.id);
  const tokens = runs.reduce((n, r) => n + r.effective, 0);
  const call = (p: Promise<unknown>) => p.then(props.onChanged, (e: Error) => props.onError(e.message));

  return (
    <aside className="panel">
      <header className="panel-head">
        <div>
          <div className="panel-id"><b>{t.id}</b> <span className={`badge role-${t.role}`}>{t.role}</span> <span className={`status-pill ${groupOf(t.status)} ${t.status}`}>{t.status}</span></div>
          <h2>{t.title}</h2>
        </div>
        <button className="ghost icon" onClick={props.onClose} title="Close (Esc)">×</button>
      </header>

      {NEEDS_YOU.includes(t.status) && <ResumeBox key={`${t.id}:${t.status}`} task={t}
        onResume={(guidance, agent, allowScope) => call(api.call("plan:resume", props.planFile, t.id, guidance, agent, allowScope))}
        onRestartClean={() => call(api.call("plan:restartClean", props.planFile, t.id))}
        onSkip={() => call(api.call("plan:skip", props.planFile, t.id))} />}
      {STOPPABLE.includes(t.status) && <StopBox key={t.id} task={t} planFile={props.planFile}
        onStop={() => call(api.call("plan:stopTask", props.planFile, t.id))} onError={props.onError} />}

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
              <select value={t.agent ?? ""} disabled={!editable}
                onChange={(e) => void call(api.call("plan:setAgent", props.planFile, t.id, e.target.value || null))}>
                <option value="">{t.assigned ? `${t.assigned} (auto)` : "auto"}</option>
                {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {!editable && <span className="muted"> locked while {t.status}</span>}
            </Field>
            <Field label="Model">
              <ModelPicker task={t} choices={props.snap.modelChoices} editable={editable}
                onSet={(model) => void call(api.call("plan:setField", props.planFile, t.id, "model", model))} />
            </Field>
            <Field label="Thinking">
              <select value={t.effort ?? ""} disabled={!editable}
                onChange={(e) => void call(api.call("plan:setField", props.planFile, t.id, "effort", e.target.value || null))}>
                <option value="">{t.routedEffort && !t.effort ? `${t.routedEffort} (routing)` : "agent default"}</option>
                {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Images">
              <label>
                <input type="checkbox" checked={t.images} disabled={!editable}
                  onChange={(e) => void call(api.call("plan:setField", props.planFile, t.id, "images", e.target.checked ? "true" : null))} />
                {" "}Codex image generation
              </label>
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

const NEEDS_YOU_TITLE: Record<string, string> = {
  waiting: "This task needs you",
  stopped: "Stopped by you",
  interrupted: "Interrupted when the app closed",
};

function ResumeBox(props: {
  task: TaskView;
  onResume: (guidance: string | null, agent: string | null, allowScope: boolean) => void;
  onRestartClean: () => void;
  onSkip: () => void;
}) {
  const [guidance, setGuidance] = useState("");
  const [agent, setAgent] = useState("");
  const t = props.task;

  // A blocked agent asked something: resuming without an answer would only buy the same question again.
  const asking = t.status === "waiting" && (t.note?.startsWith("the agent is blocked") ?? false);
  const canResume = (!asking || guidance.trim().length > 0 || agent !== "");
  // The agent changed files outside its write scope and says it needs them.
  const scope = t.scopeRequest;
  return (
    <div className="resume-box">
      <div className="resume-title">⏸ {asking ? "The agent asks" : scope.length ? "The agent needs files outside its write scope" : NEEDS_YOU_TITLE[t.status]}</div>
      {scope.length > 0 ? <>
        <ul className="plain">{scope.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
        <p className="muted small">Its edits are kept on the stash. Allow the files to keep them, or resume without them and the engine reverts them.</p>
      </> : t.note && <p className="note">{asking ? t.note.replace(/^the agent is blocked:\s*/, "") : t.note}</p>}
      <p className="muted small">{t.next}</p>
      <textarea placeholder={asking ? "Your answer (required to resume on the same agent)" : "Guidance for the agent (optional)"}
        value={guidance} onChange={(e) => setGuidance(e.target.value)} />
      <div className="row">
        <button className="ghost small" title="Count this task as finished without changes so dependent tasks can run" onClick={props.onSkip}>Skip task</button>
        <button className="ghost small" title="Drop its parked edits and start over from a fresh brief" onClick={props.onRestartClean}>Restart clean</button>
        <div className="spacer" />
        <select value={agent} onChange={(e) => setAgent(e.target.value)} title="Run it on">
          <option value="">same agent (keeps its work)</option>
          {AGENTS.filter((a) => a !== t.assigned).map((a) => <option key={a} value={a}>{a} (starts fresh)</option>)}
        </select>
        {scope.length > 0 && <button className="primary" title="Add these files to the task's write scope, restore its edits and continue"
          onClick={() => props.onResume(guidance || null, agent || null, true)}>Allow files and resume</button>}
        <button className={scope.length ? "" : "primary"} disabled={!canResume} title={scope.length ? "Revert these files and continue inside the write scope" : canResume ? "Restore its edits and continue in the same session" : "Answer the agent's question first"}
          onClick={() => props.onResume(guidance || null, agent || null, false)}>{scope.length ? "Resume without them" : "Resume"}</button>
      </div>
    </div>
  );
}

/** Stop opens an inline confirm with the facts: what gets killed, what it has cost so far, what waits, what you can do after. */
function StopBox(props: { task: TaskView; planFile: string; onStop: () => void; onError: (e: string) => void }) {
  const [info, setInfo] = useState<StopInfo | null>(null);
  const open = (): void => {
    api.call<StopInfo>("plan:stopInfo", props.planFile, props.task.id).then(setInfo, (e: Error) => props.onError(e.message));
  };
  if (!info) {
    return (
      <div className="stop-row">
        <span className="muted small">{props.task.next}</span>
        <button className="danger small" onClick={open}>■ Stop</button>
      </div>
    );
  }
  const kills = info.state === "checking" ? "the running check" : `${info.agent ?? "the agent"}'s turn`;
  return (
    <div className="confirm-box">
      <div className="confirm-title">Stop {info.taskId}?</div>
      <ul className="plain facts">
        <li>{info.deferred ? <>A merge is running. The stop waits for it to finish, so git is never left half-merged.</> : <>Kills {kills} now{info.turnElapsedMs !== null ? <>, running for {fmtDuration(info.turnElapsedMs)}</> : null}.</>}</li>
        {info.state === "working" && <li>Tokens so far: {info.tokensSoFar !== null ? fmtTokens(info.tokensSoFar) : info.tokensNote ?? "not reported yet"}</li>}
        <li>{info.uncommittedFiles ? `${info.uncommittedFiles} uncommitted file${info.uncommittedFiles === 1 ? "" : "s"} get parked on the stash.` : "No uncommitted files to park."}</li>
        <li>{info.dependents.length ? `Waits while stopped: ${info.dependents.join(", ")}.` : "No other task waits on it."}</li>
        <li>Afterwards: {info.afterwards.join(" · ")}.</li>
      </ul>
      <p className="muted small">{info.ifStopped}</p>
      <div className="row">
        <div className="spacer" />
        <button className="ghost small" onClick={() => setInfo(null)}>Keep running</button>
        <button className="danger small" disabled={!info.stoppable} onClick={() => { setInfo(null); props.onStop(); }}>Stop task</button>
      </div>
    </div>
  );
}

/** A task's model: the config's models for its agent, or any id typed in. Needs an explicit agent. */
function ModelPicker(props: { task: TaskView; choices: Record<string, string[]>; editable: boolean; onSet: (model: string | null) => void }) {
  const t = props.task;
  const [draft, setDraft] = useState(t.model ?? "");
  useEffect(() => { setDraft(t.model ?? ""); }, [t.model]);
  if (!t.agent) {
    return <span className="muted">{t.routedModel ?? "agent default"} (routing) · pick an agent above to choose a model</span>;
  }
  const listId = `models-${t.id}`;
  const commit = (): void => { if (draft.trim() !== (t.model ?? "")) props.onSet(draft.trim() || null); };
  return (
    <>
      <input list={listId} value={draft} disabled={!props.editable} placeholder={t.routedModel ? `${t.routedModel} (routing)` : "agent default"}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
      <datalist id={listId}>{(props.choices[t.agent] ?? []).map((m) => <option key={m} value={m} />)}</datalist>
    </>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return <div className="field"><div className="label">{props.label}</div><div>{props.children}</div></div>;
}

function List(props: { items: string[]; code?: boolean }) {
  return <ul className="plain">{props.items.map((i) => <li key={i}>{props.code ? <code>{i}</code> : i}</li>)}</ul>;
}
