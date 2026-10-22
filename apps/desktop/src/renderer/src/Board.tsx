import { FINAL, groupOf, IN_FLIGHT, NEEDS_YOU, fmtTokens, type Snapshot, type TaskView } from "./api";

const COLUMNS: Array<{ group: ReturnType<typeof groupOf>; label: string }> = [
  { group: "queued", label: "Planned" },
  { group: "running", label: "Running" },
  { group: "needs-you", label: "Needs you" },
  { group: "done", label: "Done" },
];

/** Why a task needs you, as a short badge. */
const REASON: Record<string, string> = { waiting: "needs an answer", stopped: "stopped", interrupted: "interrupted" };

export function Board(props: {
  snap: Snapshot;
  selected: string | null;
  onSelect: (id: string) => void;
  blockedReviews: Snapshot["reviews"];
  onReview: (agent: string, action: "approve" | "retry") => void;
}) {
  const { snap } = props;
  const tokensByTask = new Map<string, number>();
  for (const r of snap.runs) if (r.taskId) tokensByTask.set(r.taskId, (tokensByTask.get(r.taskId) ?? 0) + r.effective);
  const activeReviews = snap.reviewStates.filter((r) => r.state === "reviewing" || r.state === "fixing");
  const doneIds = new Set(snap.tasks.filter((t) => FINAL.includes(t.status)).map((t) => t.id));
  // A queued task whose dependencies are done can still wait: its agent runs one task at a time.
  const agentNow = new Map(snap.agents.map((a) => [a.agent as string, a]));
  const blockedBy = (t: TaskView): string | null => {
    const a = t.assigned ? agentNow.get(t.assigned) : undefined;
    if (!a) return null;
    if (a.state === "working") return `waits for ${a.agent} (on ${a.task === "review" ? "a review" : a.task ?? "another task"})`;
    if (a.state === "limited") return `${a.agent} at its usage limit`;
    if (a.state === "held") return `${a.agent} taken over by you`;
    return null;
  };

  return (
    <section className="board">
      {COLUMNS.map((col) => {
        const tasks = snap.tasks.filter((t) => groupOf(t.status) === col.group);
        const extra = col.group === "needs-you" ? props.blockedReviews.length : col.group === "running" ? activeReviews.length : 0;
        return (
          <div key={col.group} className={`column ${col.group}`}>
            <h3>{col.label} <span className="count">{tasks.length + extra}</span></h3>
            <div className="cards">
              {tasks.map((t) => (
                <Card key={t.id} task={t} tokens={tokensByTask.get(t.id) ?? 0} selected={props.selected === t.id}
                  waitingOn={t.status === "queued" ? t.dependsOn.filter((d) => !doneIds.has(d)) : []}
                  agentBusy={t.status === "queued" ? blockedBy(t) : null} onClick={() => props.onSelect(t.id)} />
              ))}
              {col.group === "running" && activeReviews.map((r) => (
                <div key={r.agent} className={`card review active ${props.selected === `review:${r.agent}` ? "selected" : ""}`} role="button" tabIndex={0}
                  onClick={() => props.onSelect(`review:${r.agent}`)} onKeyDown={(e) => { if (e.key === "Enter") props.onSelect(`review:${r.agent}`); }}>
                  <div className="card-head"><b>Review · {r.agent}'s work</b>{r.round > 0 && <span className="badge">round {r.round}</span>}</div>
                  <div className="meta"><span className="live">{r.state === "fixing"
                    ? `${r.agent} is fixing ${r.reviewer ?? "the reviewer"}'s findings`
                    : "being reviewed"}</span></div>
                  <p className="next clamp">covers {r.tasks.join(", ")}{r.state === "fixing" ? "; a fresh review follows" : ""}</p>
                </div>
              ))}
              {col.group === "needs-you" && props.blockedReviews.map((r) => {
                const st = snap.reviewStates.find((x) => x.agent === r.agent);
                return (
                  <div key={r.agent} className={`card review ${props.selected === `review:${r.agent}` ? "selected" : ""}`} role="button" tabIndex={0}
                    onClick={() => props.onSelect(`review:${r.agent}`)} onKeyDown={(e) => { if (e.key === "Enter") props.onSelect(`review:${r.agent}`); }}>
                    <div className="card-head"><b>Review · {r.agent}'s work</b><span className="badge">round {r.round}</span></div>
                    {st?.why && <p className="note clamp">{st.why}</p>}
                    <div className="meta"><span>covers {st?.tasks.join(", ") ?? "?"} · rejected by {r.reviewer}</span><span className="tok">open for details</span></div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Card(props: { task: TaskView; tokens: number; selected: boolean; waitingOn: string[]; agentBusy: string | null; onClick: () => void }) {
  const t = props.task;
  return (
    <div className={`card ${t.assigned ?? ""} ${props.selected ? "selected" : ""}`} onClick={props.onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") props.onClick(); }}>
      <div className="card-head">
        <b>{t.id}</b>
        <span className={`badge role-${t.role}`}>{t.role}</span>
        <span className={`agent-tag ${t.assigned ?? ""}`}>{t.assigned ?? "?"}{t.agent ? "" : " · auto"}</span>
        {NEEDS_YOU.includes(t.status) && <span className={`badge state-${t.status}`}>{REASON[t.status]}</span>}
        {t.status === "skipped" && <span className="badge">skipped</span>}
      </div>
      <div className="title">{t.title}</div>
      <div className="meta">
        {props.waitingOn.length > 0 && <span>waits for {props.waitingOn.join(", ")}</span>}
        {props.waitingOn.length === 0 && props.agentBusy && <span className="live">{props.agentBusy}</span>}
        {IN_FLIGHT.includes(t.status) && <span className="live">{t.status}{t.attempts ? ` · attempt ${t.attempts + 1}` : ""}</span>}
        {!IN_FLIGHT.includes(t.status) && t.attempts > 0 && !FINAL.includes(t.status) && <span>attempt {t.attempts + 1}</span>}
        {props.tokens > 0 && <span className="tok">{fmtTokens(props.tokens)}</span>}
      </div>
      {IN_FLIGHT.includes(t.status) && <p className="next clamp">{t.next}</p>}
      {t.note && <p className="note clamp">{t.note}</p>}
    </div>
  );
}
