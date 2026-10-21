import { fmtTime, fmtTokens, type EventView } from "./api";

/** One readable line per engine event. Returns null for events not worth a line. */
export function describe(e: EventView): { tone: "info" | "ok" | "warn" | "err" | "run"; text: string; details?: string } | null {
  const d = e.data;
  const s = (k: string): string => String(d[k] ?? "");
  switch (e.type) {
    case "task": {
      const who = d.agent ? ` · ${s("agent")}` : "";
      const note = d.note ? ` — ${s("note")}` : "";
      const tone = d.status === "done" ? "ok" : d.status === "paused" ? "warn" : "info";
      const verb = { running: "started", done: "done", paused: "paused", pending: "queued" }[s("status")] ?? s("status");
      return { tone, text: `${s("taskId")} ${verb}${who}${note}`, ...(d.details ? { details: s("details") } : {}) };
    }
    case "run":
      return { tone: d.outcome === "done" ? "run" : "err", text: `${s("agent")} ${s("phase")}${d.taskId ? ` ${s("taskId")}` : ""}: ${s("outcome")} · ${fmtTokens(Number(d.effective))} tokens` };
    case "needs-you": return { tone: "warn", text: `Needs you: ${s("message")}` };
    case "plan": return { tone: d.status === "ready" || d.status === "merged" ? "ok" : "info", text: `Plan ${s("status")}${d.message ? `: ${s("message")}` : ""}` };
    case "info": return { tone: "info", text: s("message") };
    default: return null;
  }
}

export function ActivityList(props: { events: EventView[]; filterTask?: string; newestFirst?: boolean }) {
  let rows = props.events;
  if (props.filterTask) rows = rows.filter((e) => e.data.taskId === props.filterTask || String(e.data.message ?? "").includes(`${props.filterTask}`));
  if (props.newestFirst) rows = [...rows].reverse();
  const lines = rows.map((e) => ({ e, d: describe(e) })).filter((x) => x.d);
  if (!lines.length) return <div className="muted pad">Nothing yet.</div>;
  return (
    <ul className="activity">
      {lines.map(({ e, d }) => (
        <li key={e.id} className={`tone-${d!.tone}`}>
          <span className="time">{fmtTime(e.ts)}</span>
          <span className="text">{d!.text}</span>
          {d!.details && <details><summary>details</summary><pre>{d!.details}</pre></details>}
        </li>
      ))}
    </ul>
  );
}
