import { createHash } from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { type Catalog, loadCatalog } from "./catalog.js";
import { type Classify, createClassifier } from "./classifier.js";
import { type Config, isTrusted, loadConfig } from "./config.js";
import { type GitSnapshot, gitSnapshot } from "./git.js";
import { createHookRunner, type HookRunner, loadSettings } from "./hooks.js";
import { connectMcp, loadMcpFile, type McpLoad } from "./mcp.js";
import { loadSkills, readDisabledSkills, type Skill, skillTool } from "./skills.js";
import { ensureHome, homeLayout, type PlifHome } from "./home.js";
import { ensureMemoryDir, memoryDirFor } from "./memory.js";
import { type ModelClient, type ModelRoles, modelFromProvider, modelRoles } from "./model.js";
import { createSessionTitler, TitledSessionStore } from "./session-title.js";
import { expandHome } from "./paths.js";
import { loadClassifierPrompt, loadSystemPrompt } from "./prompts.js";
import { createSummarizer } from "./summarizer.js";
import { probeSandbox } from "./sandbox.js";
import type { Summarize } from "./context.js";
import { SessionStore } from "./session.js";
import { BackgroundTasks } from "./tasks.js";
import { Terminals } from "./terminals.js";
import { SUBAGENT_TYPES, Subagents, type SubagentType, subagentTools } from "./subagents.js";
import { TOOLS } from "./tools/index.js";
import { type RegisteredTool, register } from "./tools/registry.js";
import type { SandboxSettings } from "./types.js";

export interface Runtime {
  readonly layout: PlifHome;
  readonly root: string;
  readonly userHome: string;
  readonly catalog: Catalog;
  readonly config: Config;
  readonly model: ModelClient;
  // The model of each internal job, from [models] in config.toml.
  readonly roles: ModelRoles;
  readonly classify: Classify;
  readonly summarize: Summarize;
  readonly sessions: SessionStore;
  readonly tools: readonly RegisteredTool[];
  readonly sandbox: SandboxSettings | null;
  readonly sandboxAvailable: boolean;
  readonly baseSystem: string;
  readonly memoryDir: string;
  readonly git: GitSnapshot | null;
  readonly hooks: HookRunner;
  readonly mcpErrors: readonly string[];
  readonly skills: readonly Skill[];
  readonly skillErrors: readonly string[];
  readonly tasks: BackgroundTasks;
  readonly terminals: Terminals;
  readonly subagents: Subagents;
  // System prompt of each subagent type: the base prompt with only the tools that type gets.
  readonly subagentSystems: Readonly<Record<SubagentType, string>>;
  dispose(): Promise<void>;
}

export function sandboxSettingsFor(config: Config, userHome: string): SandboxSettings | null {
  if (config.sandbox_mode === "danger-full-access") return null;
  return {
    readOnly: config.sandbox_mode === "read-only",
    network: config.sandbox.network,
    maskPaths: config.sandbox.mask_paths.map((entry) => expandHome(entry, userHome)),
    writableRoots: config.sandbox.writable_roots.map((entry) => expandHome(entry, userHome)),
  };
}

export async function buildRuntime(cwd: string, homeRoot: string, model?: ModelClient): Promise<Runtime> {
  const layout = homeLayout(homeRoot);
  await ensureHome(layout);
  const root = await realpath(cwd);
  const userHome = await realpath(homedir());
  const config = await loadConfig(layout.config);
  const catalog = await loadCatalog(layout.models);
  const roles = modelRoles(config, catalog);
  // One cache key per project: the system prompt and the tools are the same prefix in every session of it.
  const promptCacheKey = `plif-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
  const client = model ?? modelFromProvider(config.provider, process.env, { catalog, promptCacheKey });
  const sandbox = sandboxSettingsFor(config, userHome);
  const sandboxAvailable = sandbox !== null && (await probeSandbox(root, sandbox));
  const memoryDir = memoryDirFor(layout, root);
  if (config.memory.enabled) await ensureMemoryDir(memoryDir, root);
  const git = await gitSnapshot(root);
  // Project settings and MCP servers only load after the user trusts the folder.
  const trusted = isTrusted(config, root);
  const hooks = createHookRunner([
    await loadSettings(path.join(layout.root, "settings.json")),
    trusted ? await loadSettings(path.join(root, ".plif", "settings.json"), "project") : { hooks: {} },
  ]);
  const tasks = new BackgroundTasks();
  const terminals = new Terminals();
  const subagents = new Subagents();
  const subagentSystems = Object.fromEntries(
    await Promise.all(
      SUBAGENT_TYPES.map(async (type) => [type, await loadSystemPrompt(subagentTools(TOOLS, type).map((tool) => tool.name))] as const),
    ),
  ) as Record<SubagentType, string>;
  const mcp: McpLoad = await connectMcp({
    ...(await loadMcpFile(path.join(layout.root, "mcp.json"))),
    ...(trusted ? await loadMcpFile(path.join(root, ".plif", "mcp.json")) : {}),
  });
  const skillLoad = await loadSkills(
    [
      { dir: path.join(layout.root, "skills"), source: "user" },
      ...(trusted ? [{ dir: path.join(root, ".plif", "skills"), source: "project" as const }] : []),
    ],
    await readDisabledSkills(path.join(layout.root, "skills.json")),
  );
  const skillTools = skillLoad.skills.length > 0 ? [register(skillTool(skillLoad.skills))] : [];
  return {
    layout,
    root,
    userHome,
    catalog,
    config,
    model: client,
    roles,
    classify: createClassifier(client, await loadClassifierPrompt(), roles.classifier),
    summarize: createSummarizer(client, roles.compaction),
    // An injected client (tests) gets no title requests, which would take its scripted answers.
    sessions:
      model === undefined
        ? new TitledSessionStore(layout.sessions, createSessionTitler(client, roles.sessionSummary))
        : new SessionStore(layout.sessions),
    // A getter: MCP servers can change their tool list during the session.
    get tools() {
      return [...TOOLS, ...mcp.tools, ...skillTools];
    },
    sandbox,
    sandboxAvailable,
    baseSystem: await loadSystemPrompt(TOOLS.map((tool) => tool.name)),
    memoryDir,
    git,
    hooks,
    mcpErrors: mcp.errors,
    skills: skillLoad.skills,
    skillErrors: skillLoad.errors,
    tasks,
    terminals,
    subagents,
    subagentSystems,
    dispose: async () => {
      tasks.stopAll();
      terminals.stopAll();
      subagents.stopAll();
      await mcp.close();
    },
  };
}
