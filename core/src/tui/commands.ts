export interface SlashCommand {
  readonly name: string;
  readonly args: string;
  readonly description: string;
}

// Only commands that change something. Mode, sandbox and hooks are shown elsewhere (shift+tab, the status line, settings.json).
export const COMMANDS: readonly SlashCommand[] = [
  { name: "help", args: "", description: "list the commands" },
  { name: "model", args: "[id]", description: "show or change the model" },
  { name: "effort", args: "[level]", description: "open the effort scale, or set a level" },
  { name: "resume", args: "[id]", description: "pick a session to resume" },
  { name: "clear", args: "", description: "start a new session" },
  { name: "coauthor", args: "[on|off]", description: "show or change the co-author line" },
  { name: "mcp", args: "", description: "browse and install MCP servers" },
  { name: "tasks", args: "", description: "show background tasks" },
  { name: "artifacts", args: "", description: "list the session's artifacts" },
  { name: "vps", args: "", description: "add a VPS, or switch one on for this session" },
  { name: "exit", args: "", description: "quit Plif" },
];

export function matchingCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const typed = input.slice(1);
  return COMMANDS.filter((command) => command.name.startsWith(typed));
}

export function parseCommand(input: string): { readonly name: string; readonly arg: string } {
  const trimmed = input.trim().replace(/^\//, "");
  const space = trimmed.indexOf(" ");
  if (space === -1) return { name: trimmed, arg: "" };
  return { name: trimmed.slice(0, space), arg: trimmed.slice(space + 1).trim() };
}
