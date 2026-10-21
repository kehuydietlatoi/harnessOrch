import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import {
  AGENT_IDS, DEFAULT_CONFIG, PlanRunner, Store, planKey, cacheHitRate, orchHome, parsePlan, plannerArgs, setTaskAgent,
  type AgentId, type RunnerEvent,
} from "@harnessorch/engine";

const here = fileURLToPath(new URL(".", import.meta.url));
const settingsFile = (): string => join(app.getPath("userData"), "settings.json");

interface Settings { repo?: string }
function loadSettings(): Settings {
  try { return JSON.parse(readFileSync(settingsFile(), "utf8")) as Settings; } catch { return {}; }
}
function saveSettings(s: Settings): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

let win: BrowserWindow | null = null;
let settings: Settings = {};
const store = new Store(join(orchHome(), "harness.db"));
const runners = new Map<string, PlanRunner>();
let plansWatcher: FSWatcher | null = null;

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

const plansDir = (): string | null => (settings.repo ? join(settings.repo, ".harness", "plans") : null);

function watchPlans(): void {
  plansWatcher?.close();
  plansWatcher = null;
  const dir = plansDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  plansWatcher = watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(() => send("plans:changed", null), 150);
  });
}

function runnerFor(file: string): PlanRunner {
  if (!settings.repo) throw new Error("open a repository first");
  let r = runners.get(file);
  if (r) return r;
  r = new PlanRunner({ repo: settings.repo, planFile: file, store, config: DEFAULT_CONFIG });
  r.on("event", (event: RunnerEvent) => {
    send("runner:event", { file, event });
    if (event.type === "needs-you") notify("harnessOrch needs you", event.message);
    if (event.type === "plan" && event.status === "ready") notify("Plan ready to merge", event.message ?? "All tasks done and reviewed.");
  });
  runners.set(file, r);
  return r;
}

function listPlans(): Array<{ file: string; title: string; tasks: number; done: number; errors: number; status: string | null }> {
  const dir = plansDir();
  if (!dir || !existsSync(dir)) return [];
  const rank = (s: string | null): number => ({ running: 0, paused: 1, ready: 2 } as Record<string, number>)[s ?? ""] ?? (s === "merged" ? 9 : 3);
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((name) => {
    const file = join(dir, name);
    const { plan, errors } = parsePlan(readFileSync(file, "utf8"));
    const status = store.plan(planKey(settings.repo!, file))?.status ?? null;
    return { file, title: plan.header.title, tasks: plan.tasks.length, done: plan.tasks.filter((t) => t.done).length, errors: errors.length, status };
  }).sort((a, b) => rank(a.status) - rank(b.status));
}

function snapshot(file: string) {
  const r = runnerFor(file);
  const { errors, warnings } = r.load();
  const snap = r.snapshot();
  const agents = AGENT_IDS.map((agent) => {
    const rs = snap.runs.filter((x) => x.agent === agent);
    const sum = rs.reduce((u, x) => ({ input: u.input + x.usage.input, cacheRead: u.cacheRead + x.usage.cacheRead, cacheWrite: u.cacheWrite + x.usage.cacheWrite }), { input: 0, cacheRead: 0, cacheWrite: 0 });
    const state = snap.agentStates.find((s) => s.agent === agent);
    return { agent, runs: rs.length, effective: rs.reduce((n, x) => n + x.effective, 0), cacheHit: cacheHitRate(sum),
      active: state?.state === "working", state: state?.state ?? "idle", task: state?.task ?? null, until: state?.until ?? null };
  });
  const events = store.events(r.key);
  return { ...snap, errors, warnings, agents, reviews: store.reviews(r.key), running: r.running,
    startedAt: events.find((e) => e.type === "plan")?.ts ?? null, events: events.slice(-300) };
}

// ---- terminals ----------------------------------------------------------------

interface Term { proc: pty.IPty; agent?: AgentId; file?: string }
const terms = new Map<string, Term>();
let termSeq = 0;

/** Windows: run through cmd so npm .cmd shims resolve; quote arguments with spaces. */
function shellLaunch(cmd: string, args: string[]): { file: string; args: string[] | string } {
  if (process.platform !== "win32") return { file: cmd, args };
  const q = (s: string): string => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  // A string is passed to CreateProcess verbatim; an array would be re-escaped by node-pty.
  return { file: process.env.ComSpec ?? "cmd.exe", args: `/d /s /c "${[cmd, ...args].map(q).join(" ")}"` };
}

function emptyMcpConfig(): string {
  const path = join(orchHome(), "empty-mcp.json");
  if (!existsSync(path)) {
    mkdirSync(orchHome(), { recursive: true });
    writeFileSync(path, '{"mcpServers":{}}');
  }
  return path;
}

function spawnTerm(cmd: string, args: string[], cwd: string, cols: number, rows: number, extra: Omit<Term, "proc"> = {}): string {
  const id = `t${++termSeq}`;
  const launch = shellLaunch(cmd, args);
  const proc = pty.spawn(launch.file, launch.args, {
    name: "xterm-256color", cols, rows, cwd,
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as Record<string, string>,
  });
  proc.onData((data) => send("pty:data", { id, data }));
  proc.onExit(({ exitCode }) => {
    const t = terms.get(id);
    terms.delete(id);
    if (t?.agent && t.file) runners.get(t.file)?.release(t.agent);
    send("pty:exit", { id, exitCode });
  });
  terms.set(id, { proc, ...extra });
  return id;
}

/** Interactive Opus planner in the repo, with the plan-format prompt and nothing else loaded. */
function spawnPlanner(cols: number, rows: number): string {
  if (!settings.repo) throw new Error("open a repository first");
  const args = plannerArgs(DEFAULT_CONFIG);
  const i = args.indexOf("--mcp-config");
  args[i + 1] = emptyMcpConfig(); // a file path survives cmd.exe quoting; inline JSON does not
  return spawnTerm(DEFAULT_CONFIG.adapters.claude.cmd, args, settings.repo, cols, rows);
}

/** Resume an agent's own session interactively in its lane; the engine holds the lane meanwhile. */
function spawnTakeover(file: string, agent: AgentId, cols: number, rows: number): string {
  const r = runnerFor(file);
  const lane = r.hold(agent);
  if (!lane) throw new Error(`${agent} is in the middle of a turn; wait for it to finish`);
  if (!lane.sessionId || !existsSync(lane.path)) {
    r.release(agent);
    throw new Error(`${agent} has no session in this plan yet`);
  }
  const cmd = DEFAULT_CONFIG.adapters[agent].cmd;
  const args = agent === "claude"
    ? ["--resume", lane.sessionId, "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", emptyMcpConfig()]
    : agent === "codex" ? ["resume", lane.sessionId] : ["-s", lane.sessionId];
  return spawnTerm(cmd, args, lane.path, cols, rows, { agent, file });
}

// ---- IPC ----------------------------------------------------------------------

function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try { return { ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) }; } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

handle("repo:get", () => settings.repo ?? null);
handle("repo:choose", async () => {
  const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Open a git repository" });
  if (result.canceled || !result.filePaths[0]) return settings.repo ?? null;
  settings = { ...settings, repo: result.filePaths[0] };
  saveSettings(settings);
  for (const r of runners.values()) r.stop();
  runners.clear();
  watchPlans();
  return settings.repo;
});
handle("plans:list", () => listPlans());
handle("plan:snapshot", (file: string) => snapshot(file));
handle("plan:start", (file: string) => {
  const r = runnerFor(file);
  void r.run().catch((error: unknown) => send("runner:event", { file, event: { type: "info", message: `run failed: ${String(error)}` } }));
  return true;
});
handle("plan:stop", (file: string) => { runnerFor(file).stop(); return true; });
handle("plan:setAgent", (file: string, taskId: string, agent: string | null) => {
  writeFileSync(file, setTaskAgent(readFileSync(file, "utf8"), taskId, agent ?? undefined));
  return true;
});
handle("plan:resume", async (file: string, taskId: string, guidance: string | null, agent: AgentId | null) => {
  const r = runnerFor(file);
  await r.prepare();
  r.resumeTask(taskId, { ...(guidance ? { guidance } : {}), ...(agent ? { agent } : {}) });
  if (!r.running) void r.run();
  return true;
});
handle("plan:review", async (file: string, agent: string, action: "approve" | "retry") => {
  const r = runnerFor(file);
  await r.prepare();
  r.resolveReview(agent, action);
  if (!r.running) void r.run();
  return true;
});
handle("plan:merge", async (file: string) => {
  const r = runnerFor(file);
  await r.prepare();
  return r.mergeToBase();
});
handle("plan:open", (file: string) => shell.openPath(file));
handle("plan:taskDiff", async (file: string, taskId: string) => {
  // Commits live in the shared object store: no need to (re)create worktrees just to read a diff.
  return runnerFor(file).taskDiff(taskId);
});
handle("log:open", (path: string) => shell.openPath(path));
handle("pty:planner", (cols: number, rows: number) => spawnPlanner(cols, rows));
handle("pty:takeover", (file: string, agent: AgentId, cols: number, rows: number) => spawnTakeover(file, agent, cols, rows));
handle("pty:write", (id: string, data: string) => { terms.get(id)?.proc.write(data); return true; });
handle("pty:resize", (id: string, cols: number, rows: number) => { terms.get(id)?.proc.resize(Math.max(cols, 10), Math.max(rows, 4)); return true; });
handle("pty:kill", (id: string) => { terms.get(id)?.proc.kill(); return true; });

// ---- window -------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1000, minHeight: 640, backgroundColor: "#0f1115", title: "harnessOrch",
    webPreferences: { preload: join(here, "../preload/index.mjs"), sandbox: false, contextIsolation: true, backgroundThrottling: false,
      ...(process.env.HARNESS_SCREENSHOT ? { offscreen: true } : {}) },
    ...(process.env.HARNESS_SCREENSHOT ? { show: false } : {}),
  });
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") console.error(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on("preload-error", (_e, path, error) => console.error(`[preload] ${path}: ${error.message}`));
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"), process.env.HARNESS_UI_HASH ? { hash: process.env.HARNESS_UI_HASH } : undefined);
  // Dev hook: HARNESS_AUTOSTART=<plan.md> starts that plan as soon as the window has loaded.
  const autostart = process.env.HARNESS_AUTOSTART;
  if (autostart) win.webContents.once("did-finish-load", () => void runnerFor(autostart).run());
  // Self-check hook: HARNESS_SCREENSHOT=<png> captures the page once it has settled, then quits.
  const shot = process.env.HARNESS_SCREENSHOT;
  if (shot) {
    const capture = async (path: string): Promise<void> => writeFileSync(path, (await win!.webContents.capturePage()).toPNG());
    const delay = Number(process.env.HARNESS_SCREENSHOT_DELAY ?? 2500);
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      if (!autostart) {
        await capture(shot);
        app.quit();
        return;
      }
      // With autostart: one capture mid-run, one when the plan settles, then quit.
      await capture(shot.replace(/\.png$/i, "-running.png"));
      runnerFor(autostart).on("event", (e: RunnerEvent) => {
        if (e.type === "plan" && e.status !== "running") setTimeout(async () => { await capture(shot); app.quit(); }, 1500);
      });
    }, delay));
  }
}

// Offscreen capture needs software compositing; normal runs keep the GPU.
if (process.env.HARNESS_SCREENSHOT) app.disableHardwareAcceleration();

app.whenReady().then(() => {
  settings = loadSettings();
  watchPlans();
  createWindow();
});
app.on("window-all-closed", () => {
  for (const r of runners.values()) r.stop();
  for (const t of terms.values()) t.proc.kill();
  plansWatcher?.close();
  store.close();
  app.quit();
});
