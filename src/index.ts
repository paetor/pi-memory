import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryCommand, type MemoryState } from "./command.ts";
import { buildRuntimeMemoryBlock } from "./resident-inject.ts";
import {
  createIndexCache,
  globalMemoryDir,
  loadConfig,
  projectMemoryDir,
} from "./storage.ts";
import { flushWritebackJournal } from "./writeback.ts";
import { registerMemorySearch } from "./search.ts";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-memory", {
    description: "Disable persistent memory injection (pi-memory)",
    type: "boolean",
    default: false,
  });

  const state: MemoryState = { enabled: undefined };
  const cache = createIndexCache();

  pi.on("before_agent_start", (event, ctx) => {
    state.enabled ??= pi.getFlag("no-memory") !== true;
    if (!state.enabled) return;

    const globalDir = globalMemoryDir();
    const projectDir = ctx.isProjectTrusted() ? projectMemoryDir(ctx.cwd) : undefined;
    const config = loadConfig(globalDir, projectDir);
    if (!config.enabled) return;

    const block = buildRuntimeMemoryBlock({ globalDir, projectDir, config, cache });
    const options = event.systemPromptOptions;
    if (options && "sections" in options) {
      options.appendSystemPrompt = [options.appendSystemPrompt, block].filter(Boolean).join("\n\n");
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    flushRuntimeMemory(ctx.cwd, ctx.isProjectTrusted());
  });

  pi.on("session_before_compact", (_event, ctx) => {
    flushRuntimeMemory(ctx.cwd, ctx.isProjectTrusted());
  });

  pi.on("session_before_switch", (_event, ctx) => {
    flushRuntimeMemory(ctx.cwd, ctx.isProjectTrusted());
  });

  registerMemoryCommand(pi, state, cache);
  registerMemorySearch(pi);
}

function flushRuntimeMemory(cwd: string, projectTrusted: boolean): void {
  const globalDir = globalMemoryDir();
  const projectDir = projectTrusted ? projectMemoryDir(cwd) : undefined;
  const config = loadConfig(globalDir, projectDir);
  if (!config.enabled) return;

  safeFlush(globalDir, "global", config);
  if (projectDir) safeFlush(projectDir, "project", config);
}

function safeFlush(dir: string, scope: "global" | "project", config: ReturnType<typeof loadConfig>): void {
  try {
    flushWritebackJournal(dir, scope, config);
  } catch {
    // Lifecycle hooks should never fail the surrounding pi session.
  }
}
