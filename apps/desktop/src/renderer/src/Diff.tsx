/** A read-only, colored unified diff. Long diffs are already capped by the engine. */
export function DiffView(props: { diff: string }) {
  if (!props.diff.trim()) return <div className="muted pad">No commits yet: the diff appears once the task has merged into the plan branch.</div>;
  const lines = props.diff.split(/\r?\n/);
  return (
    <pre className="diff">
      {lines.map((l, i) => {
        const cls = l.startsWith("commit ") ? "d-commit"
          : l.startsWith("diff --git") ? "d-file"
          : l.startsWith("@@") ? "d-hunk"
          : l.startsWith("+") && !l.startsWith("+++") ? "d-add"
          : l.startsWith("-") && !l.startsWith("---") ? "d-del"
          : /^ \S.*\|\s+\d+/.test(l) ? "d-stat" : "";
        return <div key={i} className={cls}>{l || " "}</div>;
      })}
    </pre>
  );
}
