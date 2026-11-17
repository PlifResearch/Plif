import { z } from "zod";
import { MEMORY_TYPES, deleteTopic, listTopics, readTopic, writeTopic } from "../memory.js";
import { maskSecrets } from "../secrets.js";
import type { Tool } from "./registry.js";

const schema = z.object({
  action: z.enum(["list", "read", "write", "delete"]).describe(
    "list: lists the memories. read: reads one. write: creates or updates one. delete: deletes one.",
  ),
  file: z.string().optional().describe("Topic file, such as feedback_tests.md. Required for read and delete."),
  name: z.string().optional().describe("Memory title. Required for write."),
  description: z.string().optional().describe("One-line summary. Required for write."),
  type: z.enum(MEMORY_TYPES).optional().describe("user, feedback, project or reference. Required for write."),
  body: z.string().optional().describe("Markdown content. Required for write."),
});

export const memoryTool: Tool<typeof schema> = {
  name: "Memory",
  strict: false,
  description:
    "Stores and recalls persistent memories for this project. Save only what cannot be inferred from the code: preferences, corrections, decisions and external references.",
  schema,
  policy: async () => ({ level: 2, decision: "allow", reason: "project memory, inside the memory folder" }),
  async run(input, ctx) {
    const dir = ctx.memoryDir;
    if (dir === undefined) throw new Error("memory is off in this session");

    if (input.action === "list") {
      const topics = await listTopics(dir);
      if (topics.length === 0) return "(no saved memories)";
      return topics.map((topic) => `${topic.file} [${topic.type}] ${topic.name}: ${topic.description}`).join("\n");
    }
    if (input.action === "read") {
      if (input.file === undefined) throw new Error("give the file name in file");
      return readTopic(dir, input.file);
    }
    if (input.action === "delete") {
      if (input.file === undefined) throw new Error("give the file name in file");
      await deleteTopic(dir, input.file);
      return `memory ${input.file} deleted`;
    }
    if (input.name === undefined || input.description === undefined || input.type === undefined || input.body === undefined) {
      throw new Error("write exige name, description, type e body");
    }
    const topic = await writeTopic(dir, {
      name: input.name,
      description: input.description,
      type: input.type,
      body: maskSecrets(input.body),
    });
    return `memory saved to ${topic.file}`;
  },
};
