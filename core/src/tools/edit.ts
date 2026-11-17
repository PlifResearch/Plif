import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolveReal } from "../paths.js";
import { decideFileAccess } from "../policy/decide.js";
import type { Tool } from "./registry.js";

const schema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file."),
  old_string: z.string().min(1).describe("Exact text to replace, with its original indentation."),
  new_string: z.string().describe("Text that replaces the snippet. Empty deletes the snippet."),
  replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
});

export const editTool: Tool<typeof schema> = {
  name: "Edit",
  description:
    "Replaces an exact snippet in a file already read with Read. Fails if the snippet is not unique, unless replace_all is set.",
  schema,
  policy: (input, ctx) => decideFileAccess(input.file_path, "write", ctx),
  async run(input, ctx) {
    if (input.old_string === input.new_string) throw new Error("old_string and new_string are equal");
    const real = await resolveReal(input.file_path, ctx.root, ctx.home);
    if (!ctx.readFiles.has(real)) throw new Error("read the file with Read before editing it");

    const text = await readFile(real, "utf8");
    const count = text.split(input.old_string).length - 1;
    if (count === 0) throw new Error("snippet not found; check the exact text and indentation");

    const replaceAll = input.replace_all === true;
    if (count > 1 && !replaceAll) {
      throw new Error(`the snippet appears ${count} times; include more context or use replace_all`);
    }
    const next = replaceAll
      ? text.split(input.old_string).join(input.new_string)
      : replaceFirst(text, input.old_string, input.new_string);
    await writeFile(real, next, "utf8");
    return `replacements: ${replaceAll ? count : 1}`;
  },
};

function replaceFirst(text: string, search: string, replacement: string): string {
  const index = text.indexOf(search);
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}
