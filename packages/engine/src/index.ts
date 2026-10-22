/** Public engine API for the desktop app (and any other host). */
export { DEFAULT_CONFIG, ROLES, type AgentRef, type EngineConfig, type Role } from "./config.js";
export { AGENT_IDS, claudeEnv, type AgentId, type TurnUsage } from "./agents/turn.js";
export { PlanRunner, planKey, type RunnerEvent, type RunnerOptions, type StopInfo } from "./engine/runner.js";
export { FINAL, IN_FLIGHT, NEEDS_YOU, STATE_INFO, STOPPABLE, TRANSITIONS, transition, type TaskEvent, type TaskState } from "./engine/lifecycle.js";
export { markTask, parsePlan, setTaskAgent, TASK_ROLES, validatePlan, type Plan, type PlanTask, type TaskRole } from "./plan/plan.js";
export { Store, type PlanRow, type PlanStatus, type RunRow } from "./store/store.js";
export { cacheHitRate, effectiveTokens } from "./ledger/effective.js";
export { orchHome } from "./ledger/telemetry.js";
export { listSkills, type Skill } from "./skills/skills.js";
export { PLANNER_PROMPT_PATH, plannerArgs } from "./planner/planner.js";
