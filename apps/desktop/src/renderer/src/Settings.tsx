import { useEffect, useId, useState } from "react";
import { AGENTS, EFFORTS, api } from "./api";

interface Ref { agent: string; model?: string; effort?: string; family?: string }
type Routes = Record<string, Ref[]>;
type Defaults = Record<string, { model?: string; effort?: string; family?: string }>;
interface ConfigView {
  path: string;
  user: { extraModels?: Record<string, string[]> };
  effective: { planner: Ref; routing: Routes; reviewers: Routes; defaults: Defaults };
  builtin: { planner: Ref; routing: Routes; reviewers: Routes; defaults: Defaults };
  models: Record<string, string[]>;
}

const ROLE_HELP: Record<string, string> = {
  implement: "ordinary tasks",
  small: "small, well-defined tasks",
  hard: "hard tasks and escalations",
  review: "reviewing another agent's work",
  orchestrator: "deciding what to do when a task fails",
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Routing per role, reviewers, and the default model of each agent. Saved to ~/.harnessorch/config.json. */
export function Settings(props: { onClose: () => void; onSaved: () => void }) {
  const [view, setView] = useState<ConfigView | null>(null);
  const [planner, setPlanner] = useState<Ref>({ agent: "claude" });
  const [routing, setRouting] = useState<Routes>({});
  const [reviewers, setReviewers] = useState<Routes>({});
  const [defaults, setDefaults] = useState<Defaults>({});
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.call<ConfigView>("config:get").then((v) => {
      setView(v);
      setPlanner({ ...v.effective.planner });
      setRouting(structuredClone(v.effective.routing));
      setReviewers(structuredClone(v.effective.reviewers));
      setDefaults(structuredClone(v.effective.defaults));
      setExtra(Object.fromEntries(AGENTS.map((a) => [a, (v.user.extraModels?.[a] ?? []).join(", ")])));
    }, (e: Error) => setError(e.message));
  }, []);

  if (!view) return <div className="modal-back"><div className="modal"><p className="muted">{error ?? "Loading…"}</p></div></div>;

  const save = async (): Promise<void> => {
    // Only what differs from the built-ins is written, so untouched roles keep following the defaults.
    const diff = (now: Routes, base: Routes): Routes => Object.fromEntries(Object.entries(now).filter(([k, v]) => !same(v, base[k])));
    const extraModels = Object.fromEntries(AGENTS.map((a) => [a, extra[a]?.split(/[,\s]+/).filter(Boolean) ?? []]).filter(([, m]) => (m as string[]).length));
    const user = {
      ...(!same(planner, view.builtin.planner) ? { planner } : {}),
      routing: diff(routing, view.builtin.routing),
      reviewers: diff(reviewers, view.builtin.reviewers),
      defaults: Object.fromEntries(Object.entries(defaults).filter(([k, v]) => !same(v, view.builtin.defaults[k]))),
      extraModels,
    };
    try { await api.call("config:save", user); props.onSaved(); props.onClose(); } catch (e) { setError((e as Error).message); }
  };
  const reset = async (): Promise<void> => {
    try { await api.call("config:reset"); props.onSaved(); props.onClose(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="modal-back" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Routing &amp; models</h2>
          <button className="ghost icon" onClick={props.onClose} title="Close">×</button>
        </header>
        <div className="modal-body">
          <p className="muted small">The first available choice in a list runs; the rest are fallbacks when it hits a usage limit. Changes apply to the next task that starts. Saved to <code>{view.path}</code>.</p>

          <h3>Planner</h3>
          <p className="muted small">Plan interactively with Claude Code or Codex. Changes apply to the next planning session.</p>
          <div className="ref-row">
            <select aria-label="Planner agent" value={planner.agent} onChange={(e) => {
              const agent = e.target.value;
              setPlanner(agent === view.builtin.planner.agent ? { ...view.builtin.planner } : { agent, ...defaults[agent] });
            }}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
            <ModelInput agent={planner.agent} value={planner.model ?? ""} models={view.models} onChange={(model) => setPlanner({ ...planner, model: model || undefined })} />
            <EffortSelect value={planner.effort ?? ""} onChange={(effort) => setPlanner({ ...planner, effort: effort || undefined })} />
          </div>

          <h3>Default model per agent</h3>
          <p className="muted small">What a task pinned to an agent runs on when no route names that agent.</p>
          {AGENTS.map((a) => (
            <div key={a} className="ref-row">
              <span className={`agent-tag ${a}`} style={{ width: 70, marginLeft: 0 }}>{a}</span>
              <ModelInput agent={a} value={defaults[a]?.model ?? ""} models={view.models} onChange={(model) => setDefaults({ ...defaults, [a]: { ...defaults[a], model } })} />
              <EffortSelect value={defaults[a]?.effort ?? ""} onChange={(effort) => setDefaults({ ...defaults, [a]: { ...defaults[a], effort: effort || undefined } })} />
            </div>
          ))}

          <h3>Routing</h3>
          {Object.keys(view.builtin.routing).map((role) => (
            <RefList key={role} title={role} help={ROLE_HELP[role]} refs={routing[role] ?? []} models={view.models}
              onChange={(refs) => setRouting({ ...routing, [role]: refs })} />
          ))}

          <h3>Reviewers</h3>
          <p className="muted small">Who reviews the work of each agent.</p>
          {Object.keys(view.builtin.reviewers).map((author) => (
            <RefList key={author} title={`${author}'s work`} refs={reviewers[author] ?? []} models={view.models}
              onChange={(refs) => setReviewers({ ...reviewers, [author]: refs })} />
          ))}

          <h3>Extra model ids</h3>
          <p className="muted small">Added to the pickers (comma separated). Any id can also be typed straight into a picker.</p>
          {AGENTS.map((a) => (
            <div key={a} className="ref-row">
              <span className={`agent-tag ${a}`} style={{ width: 70, marginLeft: 0 }}>{a}</span>
              <input className="grow" value={extra[a] ?? ""} onChange={(e) => setExtra({ ...extra, [a]: e.target.value })} placeholder="model-id, another-id" />
            </div>
          ))}
        </div>
        {error && <div className="banner error" onClick={() => setError(null)}>{error}</div>}
        <footer className="modal-foot">
          <button className="ghost small" onClick={() => void reset()} title="Delete your changes and use the built-in routing">Reset to defaults</button>
          <div className="spacer" />
          <button className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()}>Save</button>
        </footer>
      </div>
    </div>
  );
}

function RefList(props: { title: string; help?: string; refs: Ref[]; models: Record<string, string[]>; onChange: (refs: Ref[]) => void }) {
  const set = (i: number, patch: Partial<Ref>): void => props.onChange(props.refs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number): void => {
    const next = [...props.refs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    props.onChange(next);
  };
  return (
    <div className="ref-list">
      <div className="ref-title"><b>{props.title}</b>{props.help && <span className="muted small"> · {props.help}</span>}</div>
      {props.refs.map((r, i) => (
        <div key={i} className="ref-row">
          <span className="muted small" style={{ width: 16 }}>{i + 1}</span>
          <select value={r.agent} onChange={(e) => set(i, { agent: e.target.value, model: undefined })}>
            {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <ModelInput agent={r.agent} value={r.model ?? ""} models={props.models} onChange={(model) => set(i, { model: model || undefined })} />
          <EffortSelect value={r.effort ?? ""} onChange={(effort) => set(i, { effort: effort || undefined })} />
          <button className="ghost icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
          <button className="ghost icon" disabled={i === props.refs.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
          <button className="ghost icon" disabled={props.refs.length === 1} onClick={() => props.onChange(props.refs.filter((_, j) => j !== i))} title="Remove">✕</button>
        </div>
      ))}
      <button className="ghost small" onClick={() => props.onChange([...props.refs, { agent: "codex" }])}>+ add fallback</button>
    </div>
  );
}

function ModelInput(props: { agent: string; value: string; models: Record<string, string[]>; onChange: (model: string) => void }) {
  const id = useId();
  return (
    <>
      <input className="grow" list={id} value={props.value} aria-label={`${props.agent} model`} placeholder={props.agent === "opencode" ? "provider/model (required)" : "agent default"}
        onChange={(e) => props.onChange(e.target.value.trim())} />
      <datalist id={id}>{(props.models[props.agent] ?? []).map((m) => <option key={m} value={m} />)}</datalist>
    </>
  );
}

function EffortSelect(props: { value: string; onChange: (effort: string) => void }) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)} title="Thinking effort">
      <option value="">default effort</option>
      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
    </select>
  );
}
