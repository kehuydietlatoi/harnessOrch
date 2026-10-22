import { useEffect, useState } from "react";
import { DiffView } from "./Diff";
import { api, fmtTime, type Snapshot } from "./api";

type Tab = "rounds" | "diff";

/** A review that needs you: every round's full notes, why it stopped, what it covered, and the diff it judged. */
export function ReviewPanel(props: {
  snap: Snapshot;
  agent: string;
  planFile: string;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  onReview: (action: "approve" | "retry") => void;
}) {
  const [tab, setTab] = useState<Tab>("rounds");
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => { setDiff(null); }, [props.agent]);
  useEffect(() => {
    if (tab !== "diff" || diff !== null) return;
    api.call<string>("plan:authorDiff", props.planFile, props.agent).then(setDiff, (e: Error) => setDiff(`Could not load diff: ${e.message}`));
  }, [tab, diff, props.planFile, props.agent]);

  const rounds = props.snap.reviews.filter((r) => r.agent === props.agent).sort((a, b) => b.round - a.round);
  const latest = rounds[0];
  const prefix = `review of ${props.agent}'s work needs you: `;
  const stopped = [...props.snap.events].reverse().find((e) => e.type === "needs-you" && String(e.data.message ?? "").startsWith(prefix));
  const why = stopped ? String(stopped.data.message).slice(prefix.length) : null;
  const tasks = props.snap.tasks.filter((t) => t.assigned === props.agent && t.status === "done");
  const st = props.snap.reviewStates.find((r) => r.agent === props.agent);

  return (
    <aside className="panel">
      <header className="panel-head">
        <div>
          <div className="panel-id"><b>Review</b> <span className="badge">{props.agent}'s work</span>
            {latest && <span className={`status-pill ${latest.decision === "approve" ? "done" : st?.state === "needs-you" ? "paused" : "running"}`}>{latest.decision === "approve" ? "approved" : st?.state === "fixing" ? `fixing · round ${latest.round}` : `rejected · round ${latest.round}`}</span>}
          </div>
          <h2>Review of {props.agent}'s work</h2>
        </div>
        <button className="ghost icon" onClick={props.onClose} title="Close (Esc)">×</button>
      </header>

      {(st?.state === "fixing" || st?.state === "reviewing") && (
        <div className="info-box">
          <div className="info-title">{st.state === "fixing" ? `${props.agent} is fixing these findings now` : `${st.reviewer ?? "A reviewer"} is reviewing now`}</div>
          <p className="muted small-text">{st.state === "fixing"
            ? `It works in its own session on ${st.tasks.join(", ")}; when the fix merges, a fresh review runs. Nothing to do yet. Watch it in the ${props.agent} tab below.`
            : "The verdict lands here when it is done."}</p>
        </div>
      )}

      {st?.state === "needs-you" && (
        <div className="resume-box">
          <div className="resume-title">⏸ This review needs you</div>
          {(st.why ?? why) && <p className="note">{st.why ?? why}</p>}
          <p className="muted small-text">Read the reviewer's notes and the diff, then decide: accept the work as it is, or let a fresh review run.</p>
          <div className="row">
            <button onClick={() => props.onReview("retry")} title="Run the review again (after you fixed something yourself, for example)">Review again</button>
            <button className="primary" onClick={() => props.onReview("approve")} title="Accept the work as it is; the plan can then be merged">Approve anyway</button>
          </div>
        </div>
      )}

      <nav className="panel-tabs">
        <button className={tab === "rounds" ? "active" : ""} onClick={() => setTab("rounds")}>Rounds · {rounds.length}</button>
        <button className={tab === "diff" ? "active" : ""} onClick={() => setTab("diff")}>Diff</button>
      </nav>

      <div className="panel-body">
        {tab === "rounds" && (
          <div className="overview">
            <div className="field">
              <div className="label">Covers</div>
              <div className="links">
                {tasks.length ? tasks.map((t) => <a key={t.id} onClick={() => props.onSelectTask(t.id)}>{t.id} {t.title}</a>) : <span className="muted">no merged tasks</span>}
              </div>
            </div>
            {rounds.map((r) => (
              <div key={r.round} className={`round ${r.decision === "approve" ? "ok" : "rejected"}`}>
                <div className="round-head"><b>Round {r.round}</b> <span className="muted">by {r.reviewer}</span>
                  <span className={r.decision === "approve" ? "ok" : "warn"}>{r.decision === "approve" ? "approved" : "requested changes"}</span></div>
                <p>{r.notes || <span className="muted">(no notes)</span>}</p>
              </div>
            ))}
            {stopped && <div className="muted small-text">Stopped for you at {fmtTime(stopped.ts)}.</div>}
          </div>
        )}
        {tab === "diff" && (diff === null ? <div className="muted pad">Loading…</div> : <DiffView diff={diff} />)}
      </div>
    </aside>
  );
}
