import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { CancellationRegistry } from './agent/cancellation';
import { Inbox } from './agent/inbox';
import { CheckpointStore } from './checkpoints/store';
import { AgentLoop } from './agent/loop';
import { SubagentRunner } from './subagents';
import { createGoalTools, createSkillTool, createSubagentTool } from './tools/builtin/agent';
import { createExitPlanModeTool } from './tools/builtin/plan';
import { createPresentTool } from './tools/builtin/present';
import { createReadSpillTool } from './tools/builtin/spill';
import { createTodoTool } from './tools/builtin/todo';
import { createJobTools } from './tools/builtin/jobs';
import { JobRegistry } from './jobs/registry';
import { SpillStore } from './spill/store';
import { AttachmentStore } from './attachments/store';
import { SessionQuery } from './session/query';
import { InstructionsLoader, renderInstructions } from './context/instructions';
import { extractSessionRefs, sessionSnapshot } from './context/sessionReference';
import { createReadFileTool } from './tools/builtin/readFile';
import { createSessionRefTool } from './context/sessionReference';
import { createSubagentControlTools } from './tools/builtin/subagentControl';
import { createWorkflowTool } from './tools/builtin/workflow';
import type { AgentPromptContext, AgentPromptOptions } from './agent/loop';
import { CompactionService } from './compaction/service';
import { EventStore } from './events/store';
import type { LlmRegistry } from './llm/registry';
import type { ProviderSettingsStore } from './llm/settings';
import { mcpStatusOf, type McpStatus } from './mcp/serviceGateway';
import { BUILTIN_PLUGINS } from './plugins';
import { PluginRegistry } from './plugins/registry';
import { ProjectStore, SessionStore } from './session/store';
import { SkillLoader } from './skills/loader';
import { TitleService } from './session/title';
import { ApprovalService } from './tools/approval';
import { ToolPipeline } from './tools/pipeline';
import { ToolRegistry } from './tools/registry';
import type { McpGateway } from './tools/types';

export type { ProviderSettingsStore } from './llm/settings';
export type { McpStatus } from './mcp/serviceGateway';

export interface MemoryStats {
  projects: number;
  sessions: number;
  events: number;
  approxBytes: number;
  legacyBackup?: string;
}

/**
 * Per-session tool switches. The Task 8 schema has no table for them and the event vocabulary has no
 * `session/tools` type, so the composition root keeps them for the running app; `memory.clear()` and
 * a session delete drop them. Enforcement belongs to the turn's schema list, not here.
 */
export interface ToolPreferences {
  disabledFor(sessionId: string): string[];
  isEnabled(sessionId: string, name: string): boolean;
  set(sessionId: string, name: string, enabled: boolean): void;
  clear(sessionId?: string): void;
}

export interface Harness {
  events: EventStore;
  projects: ProjectStore;
  sessions: SessionStore;
  llm: LlmRegistry;
  providerSettings: ProviderSettingsStore;
  titles: TitleService;
  tools: ToolRegistry;
  /** Built-in, superpowers-derived skills for the in-app agent. 1.1.0 loads no external skills. */
  skills: SkillLoader;
  /** Detached child sessions for `/subagent` and the model-facing `subagent` tool (shared bookkeeping). */
  subagents: SubagentRunner;
  approvals: ApprovalService;
  pipeline: ToolPipeline;
  spill: SpillStore;
  attachments: AttachmentStore;
  jobs: JobRegistry;
  checkpoints: CheckpointStore;
  query: SessionQuery;
  agent: AgentLoop;
  inbox: Inbox;
  mcp: McpGateway;
  cancellations: CancellationRegistry;
  compaction: CompactionService;
  toolPrefs: ToolPreferences;
  memory: { stats(): MemoryStats; clear(): void };
  /** Built-in plugins in their fixed setup order. */
  plugins: PluginRegistry;
  /** Shut down plugin-owned resources in reverse setup order; safe to call more than once. */
  dispose(): Promise<void>;
  /** Status body for `GET /api/mcp/status`; Task 24's MCP panel reads it verbatim. */
  mcpStatus(): McpStatus;
  /**
   * A session runs one turn at a time: an active turn or a tool gate still holding a grant.
   * PRECONDITION for Task 18 (and every later turn caller): the active-turn half is only correct if
   * the caller owns the registry entry, i.e. every turn must `cancellations.start(sessionId)` before
   * dispatch and `cancellations.finish(sessionId, controller)` in its `finally`. `AgentLoop.runTurn`
   * builds its own `AbortController` and does not register one, so a turn that skips this reports
   * `busy(false)` while it runs; the gate half of the answer still holds either way.
   */
  busy(sessionId: string): boolean;
  /**
   * Mirror of the gateway's current tools, gated on the link actually being up. Run after every
   * reconnect (`routes/mcp.ts`) and, once Task 31's resolver has connected at boot, from there.
   */
  syncTools(): Promise<void>;
  /**
   * Indirection for `AgentLoopDeps.prompt`, which is fixed at construction. Tasks 18/27/29 assign
   * it (skills, instructions, workflow phase) without rebuilding the loop.
   */
  promptHook?: (context: AgentPromptContext) => AgentPromptOptions | undefined;
}

export interface CreateHarnessDeps {
  db: Database.Database;
  llm: LlmRegistry;
  mcp: McpGateway;
  titleModel: string;
  providerSettings: ProviderSettingsStore;
  compaction: { pruneAt: number; summarizeAt: number; keepRecentTurns: number };
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

/** The file the connection actually opened, so `legacyBackup` matches what `openDatabase` moved aside. */
function databaseFile(db: Database.Database): string {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ file?: string }>;
  return rows[0]?.file?.trim() ?? '';
}

function createToolPreferences(): ToolPreferences {
  const disabled = new Map<string, Set<string>>();
  return {
    disabledFor(sessionId) {
      return [...(disabled.get(sessionId) ?? [])];
    },
    isEnabled(sessionId, name) {
      return !disabled.get(sessionId)?.has(name);
    },
    set(sessionId, name, enabled) {
      const current = disabled.get(sessionId) ?? new Set<string>();
      if (enabled) current.delete(name);
      else current.add(name);
      if (current.size === 0) disabled.delete(sessionId);
      else disabled.set(sessionId, current);
    },
    clear(sessionId) {
      if (sessionId === undefined) disabled.clear();
      else disabled.delete(sessionId);
    },
  };
}

/**
 * The event-sourced harness as one object: every module built in Tasks 8-16 wired once, with the
 * shared `Inbox`, `CancellationRegistry` and tool gate the routes need to reason about a session.
 * Nothing here starts a provider request or a Studio connection — boot stays inert until a route asks.
 */
export function createHarness(deps: CreateHarnessDeps): Harness {
  const { db, llm, mcp, providerSettings } = deps;
  const events = new EventStore(db);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db, events);
  const tools = new ToolRegistry();
  const skillLoader = new SkillLoader(events);
  const approvals = new ApprovalService();
  // Spill store: oversized tool text is saved here and the model sees preview + locator.
  const spill = new SpillStore();
  const attachments = new AttachmentStore(db);
  const jobs = new JobRegistry();
  const checkpoints = new CheckpointStore(db);
  const query = new SessionQuery(events, sessions, db);
  // Declared before the pipeline: the pipeline's disable check closes over this object.
  const toolPrefs = createToolPreferences();
  const pipeline = new ToolPipeline(tools, approvals, (sessionId, name) => toolPrefs.isEnabled(sessionId, name), spill, checkpoints);
  const inbox = new Inbox();
  const cancellations = new CancellationRegistry();
  const plugins = new PluginRegistry(BUILTIN_PLUGINS);
  const complete = (prompt: string, model: string): Promise<string> => llm.complete(prompt, model);

  const compaction = new CompactionService({
    events,
    complete,
    // 1.1.0 has one advanced model knob (`titleModel`); summaries ride the same selection.
    model: deps.titleModel,
    config: deps.compaction,
    attachments,
  });

  const agent = new AgentLoop({
    events,
    llm,
    tools,
    pipeline,
    compaction,
    inbox,
    mcp,
    toolPrefs,
    prompt: (context) => harness.promptHook?.(context) ?? {},
    attachments,
  });

  // The model's own hands (not the user's): load skills, inspect/set the session goal, and spawn
  // subagents mid-turn. Registered after the registry exists; turn assembly reads it live.
  // Completion delivery mirrors jobs: busy parents get an inbox steer, idle parents get a wake.
  function harnessBusy(sessionId: string): boolean {
    return cancellations.has(sessionId) || !pipeline.canStart(sessionId);
  }
  function wakeParent(sessionId: string, notice: string): void {
    void (async () => {
      try {
        const detail = sessions.get(sessionId);
        const controller = cancellations.start(sessionId);
        try {
          const { createEmit } = await import('./events/emit');
          // Wake content is the notice itself as a system follow-up; the model then collects.
          await agent.runTurn({
            sessionId,
            content: notice,
            messageSource: 'notice',
            modelSelection: detail?.modelSelection ?? 'auto',
            trigger: 'goal',
            signal: controller.signal,
            maxTokens: 4096,
          }, createEmit(events, sessionId));
        } finally {
          cancellations.finish(sessionId, controller);
        }
      } catch (error) {
        console.warn(`[harness] subagent wake failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }
  const subagents = new SubagentRunner({
    events, sessions, agent, tools, llm,
    inbox,
    busy: harnessBusy,
    wake: wakeParent,
  });
  tools.register(createSkillTool({ loader: skillLoader }));
  for (const goalTool of createGoalTools({ events, sessions })) tools.register(goalTool);
  tools.register(createSubagentTool(subagents));
  tools.register(createExitPlanModeTool({ events }));
  tools.register(createPresentTool({ events }));
  tools.register(createReadSpillTool({ spill }));
  tools.register(createTodoTool({ events }));
  tools.register(createReadFileTool({ workspaceRoot: process.cwd() }));
  tools.register(createSessionRefTool({ events }));
  for (const controlTool of createSubagentControlTools(subagents)) tools.register(controlTool);
  tools.register(createWorkflowTool({ events, subagents, jobs }));
  for (const jobTool of createJobTools({ jobs, subagents })) tools.register(jobTool);

  const memory = {
    stats(): MemoryStats {
      const pageCount = Number(db.pragma('page_count', { simple: true }) ?? 0);
      const pageSize = Number(db.pragma('page_size', { simple: true }) ?? 0);
      const file = databaseFile(db);
      const backup = file ? `${file}.v1.bak` : '';
      return {
        projects: countRows(db, 'projects'),
        sessions: countRows(db, 'sessions'),
        events: countRows(db, 'session_events'),
        approxBytes: pageCount * pageSize,
        ...(backup && fs.existsSync(backup) ? { legacyBackup: path.basename(backup) } : {}),
      };
    },
    clear(): void {
      // Conversation data only: `provider_settings` is configuration, not memory.
      const live = sessions.list();
      db.transaction(() => {
        db.prepare('DELETE FROM session_events').run();
        db.prepare('DELETE FROM sessions').run();
        db.prepare('DELETE FROM projects').run();
      })();
      toolPrefs.clear();
      // A wiped session must not keep a queued steer, a gate slot or an abort controller either.
      for (const session of live) {
        cancellations.cancel(session.id);
        inbox.clear(session.id);
        pipeline.releaseSession(session.id);
      }
    },
  };

  const harness: Harness = {
    events,
    projects,
    sessions,
    llm,
    providerSettings,
    titles: new TitleService(complete, deps.titleModel),
    tools,
    skills: skillLoader,
    subagents,
    approvals,
    spill,
    attachments,
    jobs,
    checkpoints,
    query,    // Active skills (persisted per session) plus skills whose trigger appears in this message are
    // injected into the system prompt for exactly this turn. A later task may wrap this hook, but
    // must keep calling it or the working agreement silently loses its skill bodies. The catalog
    // rides along so the model can also load a skill mid-turn with the `skill` tool instead of
    // matching trigger words blindly. Workspace instructions + @session snapshots ride along too.
    promptHook: (context) => {
      const bodies = skillLoader.bodiesFor(context.sessionId, context.message);
      const skillCatalog = skillLoader.list().map((skill) => ({ name: skill.name, description: skill.description }));
      const instructionsLoader = new InstructionsLoader();
      const rendered = renderInstructions(instructionsLoader.loadAll());
      const refIds = context.message ? extractSessionRefs(context.message) : [];
      const snapshots = refIds
        .map((id) => sessionSnapshot(events, id))
        .filter((snapshot): snapshot is string => snapshot !== undefined);
      return {
        ...(bodies.length ? { skills: bodies } : {}),
        ...(skillCatalog.length ? { skillCatalog } : {}),
        ...(rendered ? { workspaceInstructions: rendered } : {}),
        ...(snapshots.length ? { sessionRefs: snapshots } : {}),
      };
    },
    pipeline,
    agent,
    inbox,
    mcp,
    cancellations,
    compaction,
    toolPrefs,
    memory,
    plugins,
    dispose: () => plugins.disposeAll(),
    mcpStatus: () => mcpStatusOf(mcp),
    busy: (sessionId) => cancellations.has(sessionId) || !pipeline.canStart(sessionId),
    // A cold boot with Studio closed is the normal case, so a disconnected gateway is not asked for
    // a tool list: `syncMcp` would keep the previous mirror anyway and log a warning that reads
    // like a failure. Whatever is connected is what the model gets.
    syncTools: () => (mcp.connected ? tools.syncMcp(mcp) : Promise.resolve()),
  };

  // Background-job completion notices (deepseek `dsh-tool-jobs`): durable lifecycle rows always;
  // busy owners get the notice injected via the inbox at the next step, idle owners are woken
  // with a follow-up turn so a completion the model never saw still reaches it.
  // The view omits ownership by contract, so map jobId -> sessionId at start.
  const jobOwners = new Map<string, string>();
  const seenJobStarts = new Set<string>();
  const originalStart = jobs.start.bind(jobs);
  jobs.start = (spec) => {
    const view = originalStart(spec);
    if (spec.sessionId !== undefined) jobOwners.set(view.id, spec.sessionId);
    if (!seenJobStarts.has(view.id)) {
      seenJobStarts.add(view.id);
      if (spec.sessionId !== undefined) {
        events.append(spec.sessionId, [{
          type: 'job/started',
          payload: { jobId: view.id, kind: view.kind, label: view.label },
        }]);
      }
    }
    return view;
  };
  jobs.subscribe((view) => {
    if (view.status !== 'completed' && view.status !== 'killed' && view.status !== 'failed') return;
    const sessionId = jobOwners.get(view.id);
    if (sessionId === undefined) return;
    jobOwners.delete(view.id);
    events.append(sessionId, [{
      type: 'job/completed',
      payload: {
        jobId: view.id,
        kind: view.kind,
        label: view.label,
        status: view.status,
        ...(view.detail !== undefined ? { detail: view.detail } : {}),
      },
    }]);
    const notice = `Background job ${view.id} (${view.kind}: ${view.label}) finished [status: ${view.status}]. Read its output with job_output.`;
    if (harnessBusy(sessionId)) {
      inbox.push(sessionId, notice, 'notice');
      return;
    }
    // Idle owner: wake with a follow-up turn. Best-effort: a failed wake must not kill the job.
    void (async () => {
      try {
        const detail = sessions.get(sessionId);
        const controller = cancellations.start(sessionId);
        try {
          const { createEmit } = await import('./events/emit');
          await agent.runTurn({
            sessionId,
            content: `Background job ${view.id} completed. Collect its output with job_output and continue.`,
            messageSource: 'notice',
            modelSelection: detail?.modelSelection ?? 'auto',
            trigger: 'goal',
            signal: controller.signal,
            maxTokens: 4096,
          }, createEmit(events, sessionId));
        } finally {
          cancellations.finish(sessionId, controller);
        }
      } catch (error) {
        console.warn(`[harness] job wake failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  // Deliberately no boot-time `syncTools()` here: the call is gated on `mcp.connected`, and the
  // gateway is disconnected at composition time in production and in every test, so a line that
  // reads like a boot sync could only ever no-op. Task 31 calls `harness.syncTools()` from its own
  // boot path, after the official resolver has connected — a boot connect here would instead spawn
  // the forbidden legacy bridge.
  //
  // Built-ins are the only plugin source in 1.1.0. `createHarness` is synchronous, so setup is
  // started here and a failure is logged instead of becoming an unhandled rejection; `dispose()`
  // awaits the in-flight run before unwinding the plugins that actually started.
  void plugins.setupAll({ harness }).catch((error: unknown) => {
    console.error('[harness] plugin setup failed:', error instanceof Error ? error.message : String(error));
  });
  return harness;
}
