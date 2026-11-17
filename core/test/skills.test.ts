import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSkills, parseSkillFile, readDisabledSkills, skillsBlock, skillTool } from "../src/skills.js";
import type { ToolContext } from "../src/types.js";

const good = (name: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: Does the ${name} work. Use when asked.\n---\n${body}\n`;

test("cabeçalho válido é lido e os inválidos são recusados", () => {
  const parsed = parseSkillFile(good("pdf-tools", "Steps here."));
  assert.equal(parsed.name, "pdf-tools");
  assert.equal(parsed.body, "Steps here.");
  assert.throws(() => parseSkillFile("no header"), /header/);
  assert.throws(() => parseSkillFile(good("Bad Name")), /lowercase/);
  assert.throws(() => parseSkillFile(good("claude-helper")), /cannot contain/);
  assert.throws(() => parseSkillFile("---\nname: ok\ndescription: <b>x</b>\n---\n"), /XML/);
  assert.throws(() => parseSkillFile("---\nname: ok\ndescription:\n---\n"), /description/);
});

test("descoberta: desativadas saem, nomes repetidos e links simbólicos são ignorados", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plif-skills-")));
  const user = path.join(root, "user");
  const project = path.join(root, "project");
  await mkdir(path.join(user, "alpha"), { recursive: true });
  await mkdir(path.join(user, "beta"), { recursive: true });
  await mkdir(path.join(project, "alpha"), { recursive: true });
  await writeFile(path.join(user, "alpha", "SKILL.md"), good("alpha"));
  await writeFile(path.join(user, "beta", "SKILL.md"), good("beta"));
  await writeFile(path.join(project, "alpha", "SKILL.md"), good("alpha"));
  await symlink(path.join(root, "outside"), path.join(user, "link"));

  const loaded = await loadSkills(
    [
      { dir: user, source: "user" },
      { dir: project, source: "project" },
    ],
    ["beta"],
  );
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["alpha"]);
  assert.equal(loaded.skills[0]?.source, "user");
  assert.equal(loaded.errors.length, 1, "the repeated name is reported");
  assert.match(skillsBlock(loaded.skills), /- alpha: Does the alpha work/);
});

test("skills.json lista as desativadas", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plif-skillcfg-")));
  const file = path.join(root, "skills.json");
  assert.deepEqual(await readDisabledSkills(file), []);
  await writeFile(file, JSON.stringify({ disabled: ["old-one"] }));
  assert.deepEqual(await readDisabledSkills(file), ["old-one"]);
});

test("ferramenta Skill: carrega instruções e lista arquivos, e nega skill desconhecida", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "plif-skilltool-")));
  const user = path.join(root, "user");
  await mkdir(path.join(user, "gamma", "scripts"), { recursive: true });
  await writeFile(path.join(user, "gamma", "SKILL.md"), good("gamma", "Run scripts/check.py first."));
  await writeFile(path.join(user, "gamma", "scripts", "check.py"), "print('ok')\n");
  const loaded = await loadSkills([{ dir: user, source: "user" }], []);
  const tool = skillTool(loaded.skills);
  const ctx = { root, home: root, session: "s" } as unknown as ToolContext;

  assert.equal((await tool.policy({ name: "gamma" }, ctx as never)).decision, "allow");
  assert.equal((await tool.policy({ name: "nope" }, ctx as never)).decision, "deny");
  const output = JSON.parse(await tool.run({ name: "gamma" }, ctx)) as { instructions: string; files: string[] };
  assert.equal(output.instructions, "Run scripts/check.py first.");
  assert.deepEqual(output.files, ["scripts/check.py"]);
  await assert.rejects(tool.run({ name: "nope" }, ctx), /unknown skill/);
});
