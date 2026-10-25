import { FINAL, groupOf, IN_FLIGHT, NEEDS_YOU, type ReviewState, type Snapshot, type TaskView } from "./api";

export interface GNode { id: string; kind: "task" | "review" | "merge"; x: number; y: number; col: number }
export interface GEdge { from: string; to: string }

export const NODE_W = 196;
export const NODE_H = 62;
const GAP_X = 64;
const GAP_Y = 14;
const PAD = 16;

/**
 * Columns by dependency depth (a task sits one column right of its deepest dependency), then one review
 * node per author agent, then the merge node. Pure so the layout can be read without the SVG.
 */
export function graphLayout(tasks: Pick<TaskView, "id" | "dependsOn" | "assigned">[], reviews: Pick<ReviewState, "agent" | "tasks">[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // a cycle is a plan error the validator reports; just do not loop
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depthOf(x, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  const maxDepth = Math.max(0, ...tasks.map((t) => depthOf(t.id)));
  const cols: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const t of tasks) cols[depthOf(t.id)].push(t.id);

  const authors = reviews.filter((r) => r.tasks.length);
  const nodes: GNode[] = [];
  const place = (ids: string[], col: number, kind: GNode["kind"]): void => ids.forEach((id, row) => nodes.push({ id, kind, col, x: PAD + col * (NODE_W + GAP_X), y: PAD + row * (NODE_H + GAP_Y) }));
  cols.forEach((ids, col) => place(ids, col, "task"));
  place(authors.map((r) => `review:${r.agent}`), maxDepth + 1, "review");
  place(["merge"], maxDepth + 2, "merge");

  const edges: GEdge[] = [];
  for (const t of tasks) for (const d of t.dependsOn) if (byId.has(d)) edges.push({ from: d, to: t.id });
  for (const r of authors) {
    for (const id of r.tasks) if (byId.has(id)) edges.push({ from: id, to: `review:${r.agent}` });
    edges.push({ from: `review:${r.agent}`, to: "merge" });
  }
  if (!authors.length) for (const t of tasks) if (!tasks.some((o) => o.dependsOn.includes(t.id))) edges.push({ from: t.id, to: "merge" });

  const width = PAD * 2 + (maxDepth + 3) * NODE_W + (maxDepth + 2) * GAP_X;
  const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length), authors.length) * (NODE_H + GAP_Y) - GAP_Y;
  return { nodes, edges, width, height };
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The plan as a dependency graph: tasks → per-author reviews → merge. Click a task or review to open it. */
export function Graph(props: { snap: Snapshot; selected: string | null; onSelect: (id: string) => void }) {
  const { snap } = props;
  const { nodes, edges, width, height } = graphLayout(snap.tasks, snap.reviewStates);
  const at = new Map(nodes.map((n) => [n.id, n]));
  const task = new Map(snap.tasks.map((t) => [t.id, t]));
  const review = new Map(snap.reviewStates.map((r) => [`review:${r.agent}`, r]));
  const finished = (id: string): boolean => {
    const t = task.get(id);
    if (t) return FINAL.includes(t.status);
    return review.get(id)?.state === "approved";
  };

  return (
    <section className="graph">
      <svg width={width} height={height} role="img" aria-label="Task dependency graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L8 4L0 8z" className="g-arrow" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
          const mid = Math.max(24, (x2 - x1) / 2);
          return <path key={`${e.from}>${e.to}`} className={`g-edge ${finished(e.from) ? "met" : ""}`} markerEnd="url(#arrow)"
            d={`M${x1} ${y1} C${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`} />;
        })}
        {nodes.map((n) => {
          if (n.kind === "merge") {
            const ready = snap.status === "ready" || snap.status === "merged";
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
                <rect className={`g-node merge ${ready ? "done" : ""}`} width={NODE_W} height={NODE_H} rx={10} />
                <text className="g-id" x={12} y={24}>Merge to {snap.baseBranch ?? "base"}</text>
                <text className="g-sub" x={12} y={44}>{snap.status === "merged" ? "merged" : ready ? "ready to merge" : "after every review passes"}</text>
              </g>
            );
          }
          if (n.kind === "review") {
            const r = review.get(n.id)!;
            const tone = r.state === "needs-you" ? "needs-you" : r.state === "approved" ? "done" : r.state === "reviewing" || r.state === "fixing" ? "running" : "queued";
            return (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="g-click" onClick={() => props.onSelect(n.id)}>
                <rect className={`g-node review ${tone} ${props.selected === n.id ? "selected" : ""}`} width={NODE_W} height={NODE_H} rx={10} />
                <text className="g-id" x={12} y={24}>Review · {r.agent}'s work</text>
                <text className="g-sub" x={12} y={44}>{r.state}{r.round > 0 ? ` · round ${r.round}` : ""}{r.reviewer ? ` · by ${r.reviewer}` : ""}</text>
              </g>
            );
          }
          const t = task.get(n.id)!;
          const tone = groupOf(t.status);
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`} className="g-click" onClick={() => props.onSelect(n.id)}>
              <rect className={`g-node ${tone} ${t.assigned ?? ""} ${props.selected === n.id ? "selected" : ""} ${IN_FLIGHT.includes(t.status) ? "live" : ""}`} width={NODE_W} height={NODE_H} rx={10} />
              <text className="g-id" x={12} y={22}>{t.id}</text>
              <text className={`g-agent ${t.assigned ?? ""}`} x={NODE_W - 12} y={22} textAnchor="end">{t.assigned ?? "?"}{t.agent ? "" : " · auto"}</text>
              <text className="g-title" x={12} y={42}>{clip(t.title, 28)}</text>
              <text className="g-sub" x={12} y={56}>{NEEDS_YOU.includes(t.status) ? `⏸ ${t.status}` : t.status}{t.attempts ? ` · attempt ${t.attempts + 1}` : ""}</text>
              <title>{t.title}</title>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
