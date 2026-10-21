import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityList } from "./Activity";
import { AGENTS, api, prefs, type Agent, type EventView, type Snapshot } from "./api";
import { Term, type TermHandle } from "./Term";

export type TabKind = "activity" | "planner" | "stream" | "takeover";
export interface DrawerTab { key: string; label: string; kind: TabKind; agent?: Agent; ptyId?: string; exited?: boolean }

const MIN_HEIGHT = 120;
const COLLAPSED = 34;

/** Terminal sessions (planner PTY, agent streams, take-overs) and where their output goes. */
export function useTerminals(onError: (e: string) => void) {
  const [tabs, setTabs] = useState<DrawerTab[]>([
    { key: "activity", label: "Activity", kind: "activity" },
    { key: "planner", label: "Planner · Opus", kind: "planner" },
    ...AGENTS.map((a) => ({ key: `stream:${a}`, label: a, kind: "stream" as const, agent: a })),
  ]);
  const [active, setActive] = useState(() => prefs.get("drawerTab", "planner"));
  const handles = useRef(new Map<string, TermHandle>());
  const pending = useRef(new Map<string, string[]>());
  const ptyToTab = useRef(new Map<string, string>());
  const plannerLive = useRef(false);

  useEffect(() => { prefs.set("drawerTab", active); }, [active]);

  const write = useCallback((key: string, data: string) => {
    const h = handles.current.get(key);
    if (h) h.write(data);
    else pending.current.set(key, [...(pending.current.get(key) ?? []), data]);
  }, []);

  const onReady = useCallback((key: string) => (h: TermHandle) => {
    handles.current.set(key, h);
    for (const d of pending.current.get(key) ?? []) h.write(d);
    pending.current.delete(key);
  }, []);

  useEffect(() => {
    const offData = api.on("pty:data", (p) => {
      const { id, data } = p as { id: string; data: string };
      const key = ptyToTab.current.get(id);
      if (key) write(key, data);
    });
    const offExit = api.on("pty:exit", (p) => {
      const { id } = p as { id: string };
      const key = ptyToTab.current.get(id);
      if (!key) return;
      if (key === "planner") plannerLive.current = false;
      write(key, "\r\n\x1b[2m[session ended]\x1b[0m\r\n");
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, exited: true, ptyId: undefined } : t)));
    });
    return () => { offData(); offExit(); };
  }, [write]);

  const size = (key: string): [number, number] => {
    const h = handles.current.get(key);
    return [h?.term.cols ?? 120, h?.term.rows ?? 30];
  };

  const startPlanner = useCallback(async () => {
    try {
      const id = await api.call<string>("pty:planner", ...size("planner"));
      ptyToTab.current.set(id, "planner");
      plannerLive.current = true;
      setTabs((ts) => ts.map((t) => (t.key === "planner" ? { ...t, ptyId: id, exited: false } : t)));
      setActive("planner");
      handles.current.get("planner")?.term.focus();
    } catch (e) { onError((e as Error).message); }
  }, [onError]);

  const takeOver = useCallback(async (planFile: string, agent: Agent) => {
    const key = `takeover:${agent}`;
    try {
      const id = await api.call<string>("pty:takeover", planFile, agent, ...size(`stream:${agent}`));
      ptyToTab.current.set(id, key);
      setTabs((ts) => [...ts.filter((t) => t.key !== key), { key, label: `${agent} · you`, kind: "takeover", agent, ptyId: id }]);
      setActive(key);
    } catch (e) { onError((e as Error).message); }
  }, [onError]);

  const closeTab = useCallback((t: DrawerTab) => {
    if (t.ptyId) void api.call("pty:kill", t.ptyId);
    if (t.kind === "takeover") {
      setTabs((ts) => ts.filter((x) => x.key !== t.key));
      setActive(`stream:${t.agent}`);
    }
  }, []);

  /** When a task starts and nothing interactive is open, show that agent's stream. */
  const followAgent = useCallback((agent: string) => {
    setActive((cur) => (cur === "planner" && !plannerLive.current ? `stream:${agent}` : cur));
  }, []);

  return { tabs, active, setActive, write, onReady, startPlanner, takeOver, closeTab, followAgent };
}

export function Drawer(props: {
  term: ReturnType<typeof useTerminals>;
  snap: Snapshot | null;
  events: EventView[];
  repo: string | null;
  planFile: string | null;
  blockedReviews: number;
}) {
  const { term, snap } = props;
  const [height, setHeight] = useState(() => prefs.get("drawerHeight", 320));
  const [collapsed, setCollapsed] = useState(() => prefs.get("drawerCollapsed", false));
  useEffect(() => { prefs.set("drawerHeight", height); }, [height]);
  useEffect(() => { prefs.set("drawerCollapsed", collapsed); }, [collapsed]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = collapsed ? MIN_HEIGHT : height;
    setCollapsed(false);
    const move = (ev: MouseEvent) => setHeight(Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 200, startH + startY - ev.clientY)));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.classList.remove("dragging"); };
    document.body.classList.add("dragging");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const activeTab = term.tabs.find((t) => t.key === term.active) ?? term.tabs[0];
  // What is waiting on you right now, not how often it happened.
  const needsYou = (snap?.tasks.filter((t) => t.status === "paused").length ?? 0) + props.blockedReviews;

  return (
    <section className={`drawer ${collapsed ? "collapsed" : ""}`} style={{ height: collapsed ? COLLAPSED : height }}>
      <div className="drawer-handle" onMouseDown={startDrag} onDoubleClick={() => setCollapsed((c) => !c)} title="Drag to resize · double-click to collapse" />
      <nav className="drawer-tabs">
        {term.tabs.map((t) => {
          const working = t.agent && snap?.agents.find((a) => a.agent === t.agent)?.state === "working";
          return (
            <div key={t.key} className={`tab ${term.active === t.key ? "active" : ""} ${t.agent ?? ""}`}
              onClick={() => { term.setActive(t.key); setCollapsed(false); }}>
              {working && t.kind === "stream" && <span className="pulse" />}
              {t.label}
              {t.kind === "activity" && needsYou > 0 && <span className="count warn">{needsYou}</span>}
              {t.kind === "planner" && t.ptyId && <span className="pulse" />}
              {t.kind === "takeover" && <span className="x" onClick={(e) => { e.stopPropagation(); term.closeTab(t); }}>Hand back ×</span>}
            </div>
          );
        })}
        <div className="spacer" />
        {activeTab.kind === "planner" && !activeTab.ptyId &&
          <button className="primary small" disabled={!props.repo} onClick={() => void term.startPlanner()}>Start planning session</button>}
        {activeTab.kind === "stream" && props.planFile && activeTab.agent && snap?.status !== "merged" &&
          <button className="small" disabled={snap?.agents.find((a) => a.agent === activeTab.agent)?.state === "working"}
            title="Resume this agent's own session in a real terminal; the engine holds its lane until you hand it back"
            onClick={() => void term.takeOver(props.planFile!, activeTab.agent!)}>Take over</button>}
        <button className="ghost icon" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>{collapsed ? "▴" : "▾"}</button>
      </nav>
      <div className="drawer-body" style={{ display: collapsed ? "none" : undefined }}>
        <div className="activity-host" style={{ display: activeTab.kind === "activity" ? "block" : "none" }}>
          <ActivityList events={props.events} newestFirst />
        </div>
        {term.tabs.filter((t) => t.kind !== "activity").map((t) => (
          <Term key={t.key} visible={!collapsed && term.active === t.key} onReady={term.onReady(t.key)}
            onInput={t.kind === "stream" ? undefined : (d) => { const id = term.tabs.find((x) => x.key === t.key)?.ptyId; if (id) void api.call("pty:write", id, d); }}
            onResize={(cols, rows) => { const id = term.tabs.find((x) => x.key === t.key)?.ptyId; if (id) void api.call("pty:resize", id, cols, rows); }} />
        ))}
      </div>
    </section>
  );
}
