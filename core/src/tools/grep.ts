import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { globPattern, isProtectedRelative, resolveReal, toModelPath } from "../paths.js";
import { decideGlob } from "../policy/decide.js";
import type { Tool } from "./registry.js";

const DEFAULT_RESULTS = 50;
const MAX_RESULTS = 200;
const MAX_FILES_SCANNED = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 300;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_PATTERN_CHARS = 300;

const schema = z.object({
  pattern: z.string().min(1).max(MAX_PATTERN_CHARS).describe("Regular expression, in JavaScript syntax."),
  path: z.string().optional().describe("Folder or file to search. Default: project root."),
  glob: z.string().optional().describe("File filter, such as **/*.ts. Default: all files."),
  output_mode: z
    .enum(["files_with_matches", "content", "count"])
    .optional()
    .describe("files_with_matches (default) lists the files. content shows the matching lines with numbers. count shows how many per file."),
  case_insensitive: z.boolean().optional().describe("Ignore case. Default false."),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .describe(`Maximum results returned. Default ${DEFAULT_RESULTS}, maximum ${MAX_RESULTS}.`),
});

export const grepTool: Tool<typeof schema> = {
  name: "Grep",
  description:
    "Searches for a pattern in the project files and returns at most head_limit results. Use files_with_matches to find files, content to see the lines and count to count them. When the output is cut, narrow the pattern, the path or the glob. Protected files, symbolic links and binary files are skipped.",
  schema,
  policy: (input, ctx) => decideGlob(input.glob ?? "**/*", input.path ?? ".", ctx),
  async run(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.case_insensitive === true ? "i" : "");
    } catch (error) {
      throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }

    const mode = input.output_mode ?? "files_with_matches";
    const limit = input.head_limit ?? DEFAULT_RESULTS;
    const base = await resolveReal(input.path ?? ".", ctx.root, ctx.home);
    const candidates = (await stat(base)).isFile()
      ? [base]
      : await fg(globPattern(input.glob ?? "**/*"), {
          cwd: base,
          absolute: true,
          onlyFiles: true,
          dot: false,
          followSymbolicLinks: false,
          ignore: [".git/**", "node_modules/**"],
        });
    candidates.sort();

    const results: string[] = [];
    let truncated = false;
    let protectedSkipped = 0;
    scan: for (const file of candidates.slice(0, MAX_FILES_SCANNED)) {
      const rel = toModelPath(path.relative(ctx.root, file));
      if (isProtectedRelative(rel)) {
        protectedSkipped++;
        continue;
      }
      const text = await readText(file);
      if (text === null) continue;

      const lines = text.split("\n");
      let count = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (!regex.test(line)) continue;
        count++;
        if (mode === "content") {
          if (results.length >= limit) {
            truncated = true;
            break scan;
          }
          results.push(`${rel}:${index + 1}:${clip(line)}`);
        }
      }
      if (count === 0 || mode === "content") continue;
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      results.push(mode === "count" ? `${rel}:${count}` : rel);
    }

    const notes: string[] = [];
    if (truncated) notes.push(`results cut at ${limit}; narrow the pattern, the path or the glob`);
    if (candidates.length > MAX_FILES_SCANNED) notes.push(`search limited to the first ${MAX_FILES_SCANNED} files`);
    if (protectedSkipped > 0) notes.push(`${protectedSkipped} protected files skipped; use Read to read them with approval`);

    let output = results.length === 0 ? "(no results)" : results.join("\n");
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS);
      notes.push("output cut at the character limit");
    }
    return [output, ...notes.map((note) => `[${note}]`)].join("\n");
  },
};

async function readText(file: string): Promise<string | null> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const bytes = await readFile(file);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return bytes.toString("utf8");
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [...]` : line;
}
