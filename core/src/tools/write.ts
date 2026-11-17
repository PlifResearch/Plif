import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveReal, toModelPath } from "../paths.js";
import { decideFileAccess } from "../policy/decide.js";
import type { Tool } from "./registry.js";

const schema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file."),
  content: z.string().describe("Full file content."),
});

export const writeTool: Tool<typeof schema> = {
  name: "Write",
  description:
    "Creates a file or replaces the whole content of a small file. For targeted changes, use Edit.",
  schema,
  policy: (input, ctx) => decideFileAccess(input.file_path, "write", ctx),
  async run(input, ctx) {
    const real = await resolveReal(input.file_path, ctx.root, ctx.home);
    const exists = await stat(real).then(
      () => true,
      () => false,
    );
    if (exists && !ctx.readFiles.has(real)) throw new Error("read the file with Read before overwriting it");

    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, input.content, "utf8");
    ctx.readFiles.add(real);
    return `wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${toModelPath(path.relative(ctx.root, real)) || real}`;
  },
};
