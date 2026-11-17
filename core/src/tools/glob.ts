import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { z } from "zod";
import { globPattern, isProtectedRelative, resolveReal, toModelPath } from "../paths.js";
import { decideGlob } from "../policy/decide.js";
import type { Tool } from "./registry.js";

const DEFAULT_IGNORE = [".git/**", "node_modules/**"];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_SCANNED = 50_000;
const MAX_COLLECTED = 20_000;
const TIME_BUDGET_MS = 5_000;
const MAX_OUTPUT_CHARS = 20_000;

const SORT_LABELS = {
  mtime: "modification time, newest first",
  size: "tamanho, maior primeiro",
  name: "nome",
} as const;

const schema = z.object({
  pattern: z
    .string()
    .min(1)
    .max(300)
    .describe("Glob pattern, relative to the base folder. Accepts **, *, ?, [abc] and {ts,tsx}. Example: src/**/*.{ts,tsx}."),
  path: z.string().optional().describe("Folder where the search starts. Default: project root."),
  type: z
    .enum(["file", "directory", "any"])
    .optional()
    .describe("file (default) lists files. directory lists folders. any lists both."),
  ignore: z
    .array(z.string().max(200))
    .min(0)
    .max(20)
    .optional()
    .describe("Patterns to exclude, such as **/*.min.js. Up to 20 patterns of up to 200 characters."),
  max_depth: z.number().int().min(1).max(50).optional().describe("Maximum folder depth. Default: no limit."),
  include_hidden: z.boolean().optional().describe("Include files and folders whose names start with a dot. Default false."),
  respect_gitignore: z.boolean().optional().describe("Respect the .gitignore at the project root. Default true."),
  sort: z
    .enum(["mtime", "size", "name"])
    .optional()
    .describe("mtime (default): newest first. size: largest first. name: alphabetical."),
  details: z.boolean().optional().describe("Include size and modification time on each line. Default false."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Results per page. Default 200, maximum 1000."),
  offset: z.number().int().min(0).max(100_000).optional().describe("How many results to skip, to read the next page."),
});

interface Row {
  readonly rel: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly isDirectory: boolean;
}

export const globTool: Tool<typeof schema> = {
  name: "Glob",
  strict: false,
  description:
    "Finds files or folders by glob pattern, sorted by date, size or name, with pagination. Does not read contents; use Grep or Read for that. Use details to see size and date. When there are more results, use offset for the next page.",
  schema,
  policy: (input, ctx) => decideGlob(input.pattern, input.path ?? ".", ctx),
  async run(input, ctx) {
    const started = Date.now();
    const base = await resolveReal(input.path ?? ".", ctx.root, ctx.home);
    if (!(await stat(base)).isDirectory()) {
      throw new Error("path must be a folder; for a specific file, use Read");
    }

    const type = input.type ?? "file";
    const gitignore = input.respect_gitignore === false ? null : await loadGitignore(ctx.root);
    const stream = fg.stream(globPattern(input.pattern), {
      cwd: base,
      dot: input.include_hidden === true,
      onlyFiles: type === "file",
      onlyDirectories: type === "directory",
      deep: input.max_depth ?? Infinity,
      followSymbolicLinks: false,
      ignore: [...DEFAULT_IGNORE, ...(input.ignore ?? []).map((pattern) => globPattern(pattern))],
      suppressErrors: true,
      unique: true,
    }) as AsyncIterable<string>;

    const found: string[] = [];
    let scanned = 0;
    let protectedSkipped = 0;
    let ignoredByGit = 0;
    let stopped: "" | "entries" | "time" = "";

    for await (const entry of stream) {
      scanned++;
      if (scanned > MAX_SCANNED || found.length >= MAX_COLLECTED) {
        stopped = "entries";
        break;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        stopped = "time";
        break;
      }
      const rel = toModelPath(path.relative(ctx.root, path.join(base, entry)));
      if (isProtectedRelative(rel)) {
        protectedSkipped++;
        continue;
      }
      if (gitignore !== null && gitignore.ignores(rel)) {
        ignoredByGit++;
        continue;
      }
      found.push(rel);
    }

    const sort = input.sort ?? "mtime";
    const needsStat = sort !== "name" || input.details === true;
    const rows = needsStat ? await withMetadata(found, ctx.root) : found.map((rel) => ({ rel, size: 0, mtimeMs: 0, isDirectory: false }));
    rows.sort(comparator(sort));

    const limit = input.limit ?? DEFAULT_LIMIT;
    const offset = input.offset ?? 0;
    const page = rows.slice(offset, offset + limit);
    const kind = type === "directory" ? "folders" : type === "any" ? "items" : "files";

    const lines = page.map((row) => (input.details === true ? formatRow(row) : row.rel));
    const notes: string[] = [];
    if (rows.length === 0) {
      notes.push("(no results)");
    } else if (page.length === 0) {
      notes.push(`(offset ${offset} is past the end; total ${rows.length})`);
    }
    const header = `${rows.length} ${kind} (mostrando ${page.length === 0 ? 0 : offset + 1}-${offset + page.length}, por ${SORT_LABELS[sort]})`;
    if (offset + limit < rows.length) notes.push(`mais ${rows.length - offset - limit} resultados: use offset=${offset + limit}`);
    if (stopped === "entries") notes.push(`search stopped after ${MAX_SCANNED} entries; narrow the pattern or use path`);
    if (stopped === "time") notes.push(`search stopped on time (${TIME_BUDGET_MS / 1000} s); narrow the pattern or use path`);
    if (protectedSkipped > 0) notes.push(`${protectedSkipped} protected files skipped`);
    if (ignoredByGit > 0) notes.push(`${ignoredByGit} ignorados pelo .gitignore`);

    let body = [header, ...lines, ...notes.map((note) => `[${note}]`)].join("\n");
    if (body.length > MAX_OUTPUT_CHARS) {
      body = `${body.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at the character limit; use a smaller limit]`;
    }
    return body;
  },
};

async function loadGitignore(root: string): Promise<Ignore | null> {
  const text = await readFile(path.join(root, ".gitignore"), "utf8").catch(() => null);
  return text === null ? null : ignore().add(text);
}

async function withMetadata(relatives: readonly string[], root: string): Promise<Row[]> {
  const rows = await Promise.all(
    relatives.map(async (rel): Promise<Row | null> => {
      const info = await lstat(path.join(root, rel)).catch(() => null);
      if (info === null || info.isSymbolicLink()) return null;
      return { rel, size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory() };
    }),
  );
  return rows.filter((row): row is Row => row !== null);
}

function comparator(sort: "mtime" | "size" | "name"): (a: Row, b: Row) => number {
  if (sort === "size") return (a, b) => b.size - a.size || compareNames(a, b);
  if (sort === "mtime") return (a, b) => b.mtimeMs - a.mtimeMs || compareNames(a, b);
  return compareNames;
}

function compareNames(a: Row, b: Row): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

function formatRow(row: Row): string {
  const date = new Date(row.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
  const name = row.isDirectory ? `${row.rel}/` : row.rel;
  return `${name}  ${formatSize(row.size)}  ${date}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
