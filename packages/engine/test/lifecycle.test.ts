import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINAL, STATE_INFO, transition, TRANSITIONS, type TaskEvent, type TaskState } from "../src/engine/lifecycle.js";

const STATES = Object.keys(TRANSITIONS) as TaskState[];
const EVENTS: TaskEvent[] = ["dispatch", "turnFinished", "failed", "blocked", "attemptsExhausted", "usageLimit", "passed", "merged",
  "retry", "human", "error", "resume", "restartClean", "skip", "stop", "appClosed"];

describe("task lifecycle", () => {
  it.each([
    ["queued", "dispatch", "working"],
    ["queued", "skip", "skipped"],
    ["working", "turnFinished", "checking"],
    ["working", "failed", "working"],
    ["working", "blocked", "escalating"],
    ["working", "attemptsExhausted", "escalating"],
    ["working", "usageLimit", "queued"],
    ["working", "stop", "stopped"],
    ["working", "appClosed", "interrupted"],
    ["checking", "passed", "merging"],
    ["checking", "failed", "working"],
    ["checking", "attemptsExhausted", "escalating"],
    ["checking", "outOfScope", "waiting"],
    ["checking", "stop", "stopped"],
    ["checking", "appClosed", "interrupted"],
    ["merging", "merged", "done"],
    ["merging", "failed", "working"],
    ["merging", "attemptsExhausted", "escalating"],
    ["merging", "stop", "stopped"],
    ["merging", "appClosed", "interrupted"],
    ["escalating", "retry", "queued"],
    ["escalating", "human", "waiting"],
    ["escalating", "appClosed", "interrupted"],
    ...(["waiting", "stopped", "interrupted"] as const).flatMap((s) => [
      [s, "resume", "queued"], [s, "restartClean", "queued"], [s, "skip", "skipped"]] as const),
    ...(["working", "checking", "merging", "escalating"] as const).map((s) => [s, "error", "waiting"] as const),
  ] as const)("%s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it("throws on every move the table does not list", () => {
    for (const s of STATES) {
      for (const e of EVENTS) {
        if (TRANSITIONS[s][e]) continue;
        expect(() => transition(s, e), `${e} from ${s}`).toThrow(/illegal task transition/);
      }
    }
    expect(() => transition("escalating", "stop")).toThrow();
    expect(() => transition("done", "resume")).toThrow();
  });

  it("final states have no way out, and every other state can still reach one", () => {
    for (const s of FINAL) expect(Object.keys(TRANSITIONS[s])).toEqual([]);
    const reaches = (from: TaskState, seen = new Set<TaskState>()): boolean => {
      if (FINAL.includes(from)) return true;
      seen.add(from);
      return Object.values(TRANSITIONS[from]).some((to) => !seen.has(to) && reaches(to, seen));
    };
    for (const s of STATES) expect(reaches(s), s).toBe(true);
  });

  it("matches the state diagram in docs/architecture.md, edge for edge", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../../docs/architecture.md", import.meta.url)), "utf8");
    const diagram = /```mermaid\nstateDiagram-v2\n([\s\S]*?)```/.exec(doc.replaceAll("\r\n", "\n"))?.[1] ?? "";
    const drawn = diagram.split("\n").flatMap((line) => {
      const m = /^\s*(\w+) --> (\w+): (.+)$/.exec(line);
      return m ? m[3].split(" / ").map((e) => `${m[1]} --${e.trim()}--> ${m[2]}`) : [];
    });
    const table = STATES.flatMap((s) => Object.entries(TRANSITIONS[s]).map(([e, to]) => `${s} --${e}--> ${to}`));
    expect(drawn.sort()).toEqual(table.sort());
  });

  it.each(STATES.filter((s) => !FINAL.includes(s)))("%s explains what happens next and what Stop does", (s) => {
    expect(STATE_INFO[s].next.length).toBeGreaterThan(10);
    expect(STATE_INFO[s].ifStopped.length).toBeGreaterThan(10);
  });
});
