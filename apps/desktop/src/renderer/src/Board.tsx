import { fmtTokens, type Snapshot, type TaskStatus, type TaskView } from "./api";

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "pending", label: "Planned" },
  { status: "running", label: "Running" },
  { status: "paused", label: "Needs you" },
  { status: "done", label: "Done" },
];

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
  const doneIds = new Set(snap.tasks.filter((t) => t.status === "done").map((t) => t.id));

  return (
    <section className="board">
      {COLUMNS.map((col) => {
        const tasks = snap.tasks.filter((t) => t.status === col.status);
        const extra = col.status === "paused" ? props.blockedReviews.length : 0;
        return (
          <div key={col.status} className={`column ${col.status}`}>
            <h3>{col.label} <span className="count">{tasks.length + extra}</span></h3>
            <div className="cards">
              {tasks.map((t) => (
                <Card key={t.id} task={t} tokens={tokensByTask.get(t.id) ?? 0} selected={props.selected === t.id}
                  waitingOn={t.status === "pending" ? t.dependsOn.filter((d) => !doneIds.has(d)) : []} onClick={() => props.onSelect(t.id)} />
              ))}
              {col.status === "paused" && props.blockedReviews.map((r) => (
                <div key={r.agent} className={`card review ${props.selected === `review:${r.agent}` ? "selected" : ""}`} role="button" tabIndex={0}
                  onClick={() => props.onSelect(`review:${r.agent}`)} onKeyDown={(e) => { if (e.key === "Enter") props.onSelect(`review:${r.agent}`); }}>
                  <div className="card-head"><b>Review · {r.agent}</b><span className="badge">round {r.round}</span></div>
                  <p className="note clamp">{r.notes}</p>
                  <div className="meta"><span>rejected by {r.reviewer}</span><span className="tok">open for details</span></div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Card(props: { task: TaskView; tokens: number; selected: boolean; waitingOn: string[]; onClick: () => void }) {
  const t = props.task;
  return (
    <div className={`card ${t.assigned ?? ""} ${props.selected ? "selected" : ""}`} onClick={props.onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") props.onClick(); }}>
      <div className="card-head">
        <b>{t.id}</b>
        <span className={`badge role-${t.role}`}>{t.role}</span>
        <span className={`agent-tag ${t.assigned ?? ""}`}>{t.assigned ?? "?"}{t.agent ? "" : " · auto"}</span>
      </div>
      <div className="title">{t.title}</div>
      <div className="meta">
        {props.waitingOn.length > 0 && <span>waits for {props.waitingOn.join(", ")}</span>}
        {t.status === "running" && <span className="live">working{t.attempts ? ` · attempt ${t.attempts + 1}` : ""}</span>}
        {t.status !== "running" && t.attempts > 0 && t.status !== "done" && <span>attempt {t.attempts + 1}</span>}
        {props.tokens > 0 && <span className="tok">{fmtTokens(props.tokens)}</span>}
      </div>
      {t.note && <p className="note clamp">{t.note}</p>}
    </div>
  );
}
