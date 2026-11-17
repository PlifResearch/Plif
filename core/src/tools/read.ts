import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { resolveReal } from "../paths.js";
import { checkImage, imageBlock, mediaTypeOf } from "../media.js";
import { decideFileAccess } from "../policy/decide.js";
import type { Tool, ToolOutput } from "./registry.js";

const DEFAULT_LIMIT = 300;
const MAX_LINE_CHARS = 400;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const schema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file."),
  offset: z.number().int().min(1).optional().describe("Starting line, counting from 1."),
  limit: z.number().int().min(1).max(10_000).optional().describe("Number of lines. Default 300."),
});

export const readTool: Tool<typeof schema, ToolOutput> = {
  name: "Read",
  description:
    "Reads a text file and returns its numbered lines. Use it before editing any existing file. PNG, JPEG, GIF and WebP images come back as images so you can see them; offset and limit do not apply to them.",
  schema,
  policy: (input, ctx) => decideFileAccess(input.file_path, "read", ctx),
  async run(input, ctx) {
    const real = await resolveReal(input.file_path, ctx.root, ctx.home);
    const info = await stat(real);
    if (info.isDirectory()) throw new Error("is a directory; use Glob to list files");
    if (info.size > MAX_FILE_BYTES) throw new Error("file too large to read directly");

    const bytes = await readFile(real);
    // An image goes back as an image block, so the model sees it. The type comes from the bytes, not the name.
    if (mediaTypeOf(bytes) !== null) {
      const image = checkImage(bytes);
      if (typeof image === "string") throw new Error(`image refused: ${image}`);
      ctx.readFiles.add(real);
      const size = image.size === null ? "" : `, ${image.size.width}x${image.size.height} px`;
      const kb = Math.max(1, Math.round(bytes.length / 1024));
      return [
        { type: "text", text: `Imagem ${real} (${image.type}${size}, ${kb} KB):` },
        imageBlock(bytes, image.type),
      ];
    }
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("binary file");

    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    ctx.readFiles.add(real);

    const start = (input.offset ?? 1) - 1;
    const selected = lines.slice(start, start + (input.limit ?? DEFAULT_LIMIT));
    if (lines.length === 0) return "(empty file)";
    if (selected.length === 0) return "(end of file)";
    return selected
      .map((line, index) => {
        const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [line cut]` : line;
        return `${start + index + 1}\t${text}`;
      })
      .join("\n");
  },
};
