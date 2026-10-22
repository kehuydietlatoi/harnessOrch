/**
 * A task's lifecycle: the states it moves through and the only legal moves
 * between them. Pure; the runner is the only caller that writes a new state,
 * through `transition()`. The scheduler's dependency graph is separate.
 */
export type TaskState =
  | "queued" | "working" | "checking" | "merging" | "escalating"
  /** Needs you: a blocked question, attempts exhausted, or an engine error. */
  | "waiting"
  | "stopped" | "interrupted" | "done" | "skipped";

export type TaskEvent =
  | "dispatch" | "turnFinished" | "failed" | "blocked" | "attemptsExhausted" | "usageLimit"
  | "passed" | "merged" | "retry" | "human" | "error"
  | "resume" | "restartClean" | "skip" | "stop" | "appClosed";

/** States with engine work in flight. */
export const IN_FLIGHT: readonly TaskState[] = ["working", "checking", "merging", "escalating"];
/** States that need a human before the task can move. */
export const NEEDS_YOU: readonly TaskState[] = ["waiting", "stopped", "interrupted"];
/** States that satisfy dependents. */
export const FINAL: readonly TaskState[] = ["done", "skipped"];
/** States the Stop button applies to. Merging defers the stop until the merge finishes. */
export const STOPPABLE: readonly TaskState[] = ["working", "checking", "merging"];

const needsYou = { resume: "queued", restartClean: "queued", skip: "skipped" } as const;
const crash = { error: "waiting" } as const;

export const TRANSITIONS: { readonly [S in TaskState]: { readonly [E in TaskEvent]?: TaskState } } = {
  queued: { dispatch: "working", skip: "skipped", ...crash },
  working: {
    turnFinished: "checking", failed: "working", blocked: "escalating", attemptsExhausted: "escalating",
    usageLimit: "queued", stop: "stopped", appClosed: "interrupted", ...crash,
  },
  checking: { passed: "merging", failed: "working", attemptsExhausted: "escalating", stop: "stopped", appClosed: "interrupted", ...crash },
  // `stop` here is applied only once the merge has failed: a stop never interrupts git mid-merge.
  // `merged` on appClosed: the merge landed before the app closed.
  merging: { merged: "done", failed: "working", attemptsExhausted: "escalating", stop: "stopped", appClosed: "interrupted", ...crash },
  escalating: { retry: "queued", human: "waiting", appClosed: "interrupted", ...crash },
  waiting: needsYou,
  stopped: needsYou,
  interrupted: needsYou,
  done: {},
  skipped: {},
};

/** The next state, or a throw: an illegal move is an engine bug, not something to paper over. */
export function transition(state: TaskState, event: TaskEvent): TaskState {
  const to = TRANSITIONS[state][event];
  if (!to) throw new Error(`illegal task transition: ${event} from ${state}`);
  return to;
}

export function canTransition(state: TaskState, event: TaskEvent): boolean {
  return TRANSITIONS[state][event] !== undefined;
}

/** What happens next in each state, and what Stop would do there. Shown on cards and in the Stop confirm. */
export const STATE_INFO: { readonly [S in TaskState]: { next: string; ifStopped: string } } = {
  queued: {
    next: "starts when its dependencies are done and its agent is free",
    ifStopped: "nothing is running yet; skip it instead if it is not needed",
  },
  working: {
    next: "the agent is working on its turn; its checks run next",
    ifStopped: "the agent's process is killed at once and its uncommitted edits are kept on the stash",
  },
  checking: {
    next: "the task's checks are running; it merges into the plan branch if they pass",
    ifStopped: "the running check is killed and the edits are kept on the stash",
  },
  merging: {
    next: "merging into the plan branch, then running the plan checks",
    ifStopped: "the stop waits until the merge finishes, so git is never left half-merged; this can take minutes if a conflict needs resolving",
  },
  escalating: {
    next: "the orchestrator is deciding whether to retry, reassign, or ask you",
    ifStopped: "an orchestrator turn cannot be stopped; it finishes on its own",
  },
  waiting: {
    next: "waiting for you: answer, pick another agent, restart clean, or skip",
    ifStopped: "nothing is running",
  },
  stopped: {
    next: "stopped by you: resume restores its edits in the same session",
    ifStopped: "nothing is running",
  },
  interrupted: {
    next: "the app closed while it ran: Start continues it with its edits",
    ifStopped: "nothing is running",
  },
  done: { next: "", ifStopped: "" },
  skipped: { next: "", ifStopped: "" },
};

/** Rows written before the lifecycle existed. `running` work died with its process. */
export const LEGACY_STATES: Readonly<Record<string, TaskState>> = { pending: "queued", running: "interrupted", paused: "waiting" };
