import { useEffect, useState } from "react";
import { fmtDuration, fmtTime, fmtTokens, groupOf, type Snapshot } from "./api";

/** Plan progress plus one live chip per agent: what it is doing, and what it has cost. */
export function StatusStrip(props: { snap: Snapshot; onSelectTask: (id: string) => void }) {
  const { snap } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!snap.running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [snap.running]);

  const total = snap.tasks.length;
  const count = (g: ReturnType<typeof groupOf>): number => snap.tasks.filter((t) => groupOf(t.status) === g).length;
  const done = count("done");
  const running = count("running");
  const paused = count("needs-you");
  const totalTokens = snap.agents.reduce((n, a) => n + a.effective, 0);
  // A finished or paused plan stops its clock at the last thing that happened.
  const end = snap.running ? now : Date.parse(snap.events.at(-1)?.ts ?? snap.startedAt ?? new Date(now).toISOString());
  const elapsed = snap.startedAt ? end - Date.parse(snap.startedAt) : null;
  const pct = (n: number): string => `${total ? (n / total) * 100 : 0}%`;

  return (
    <div className="strip">
      <div className="progress-block">
        <div className="progress-label">
          <b>{done}/{total}</b> done
          {running > 0 && <span> · {running} running</span>}
          {paused > 0 && <span className="warn"> · {paused} need you</span>}
          {elapsed !== null && <span className="muted"> · {fmtDuration(elapsed)}</span>}
        </div>
        <div className="progress" title={`${done} done, ${running} running, ${paused} need you`}>
          <div className="seg done" style={{ width: pct(done) }} />
          <div className="seg running" style={{ width: pct(running) }} />
          <div className="seg paused" style={{ width: pct(paused) }} />
        </div>
      </div>
      {snap.agents.map((a) => (
        <div key={a.agent} className={`chip ${a.agent} ${a.state}`}
          title={`${a.runs} runs · cache hit ${a.cacheHit === null ? "—" : `${Math.round(a.cacheHit * 100)}%`}`}>
          <span className="dot" />
          <b>{a.agent}</b>
          <span className="state">
            {a.state === "working" && a.task && a.task !== "review"
              ? <a onClick={() => props.onSelectTask(a.task!)}>{a.task}</a>
              : a.state === "working" ? "review" : a.state === "limited" ? `limit · back ${a.until ? fmtTime(a.until) : "later"}` : a.state === "held" ? "you" : "idle"}
          </span>
          <span className="tokens">{fmtTokens(a.effective)}</span>
        </div>
      ))}
      <div className="chip total"><b>total</b><span className="tokens">{fmtTokens(totalTokens)}</span>
        {done > 0 && <span className="muted">· {fmtTokens(Math.round(totalTokens / done))}/task</span>}
      </div>
    </div>
  );
}
