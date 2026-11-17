import { agentTool } from "./agent.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { gitTool } from "./git.js";
import { grepTool } from "./grep.js";
import { memoryTool } from "./memory.js";
import { monitorTool } from "./monitor.js";
import { planTool } from "./plan.js";
import { readTool } from "./read.js";
import { type RegisteredTool, register } from "./registry.js";
import { webFetchTool, webSearchTool, webViewTool } from "./web.js";
import { terminalTool } from "./terminal.js";
import { writeTool } from "./write.js";

export const TOOLS: RegisteredTool[] = [
  register(readTool),
  register(writeTool),
  register(editTool),
  register(globTool),
  register(grepTool),
  register(bashTool),
  register(terminalTool),
  register(gitTool),
  register(memoryTool),
  register(planTool),
  register(monitorTool),
  register(agentTool),
  register(webSearchTool),
  register(webFetchTool),
  register(webViewTool),
];
