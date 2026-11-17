import assert from "node:assert/strict";
import { test } from "node:test";
import { planTool } from "../src/tools/plan.js";
import { register } from "../src/tools/registry.js";
import type { ToolContext } from "../src/types.js";

const empty = { title: "", steps: [] as string[], step: 0, status: "pending" as const, note: "" };

function ctx(session: string): ToolContext {
  return { session } as ToolContext;
}

test("create cria o plano com todas as etapas pendentes", async () => {
  const text = await planTool.run({ ...empty, action: "create", title: "Corrigir login", steps: ["Reproduzir", "Corrigir"] }, ctx("s-create"));
  assert.match(text, /Plan: Corrigir login \(0\/2 done\)/);
  assert.match(text, /1\. \[ \] Reproduzir/);
});

test("plano com menos de duas etapas é recusado: tarefa curta não precisa de plano", async () => {
  await assert.rejects(planTool.run({ ...empty, action: "create", title: "Renomear", steps: ["Renomear"] }, ctx("s-short")), /2 to 20 steps/);
});

test("uma etapa em andamento por vez; concluir e registrar o resultado", async () => {
  const session = "s-flow";
  await planTool.run({ ...empty, action: "create", title: "Feature", steps: ["A", "B"] }, ctx(session));
  await planTool.run({ ...empty, action: "update", step: 1, status: "in_progress" }, ctx(session));
  await assert.rejects(planTool.run({ ...empty, action: "update", step: 2, status: "in_progress" }, ctx(session)), /already in progress/);
  const done = await planTool.run({ ...empty, action: "update", step: 1, status: "done", note: "testes passam" }, ctx(session));
  assert.match(done, /1\. \[x\] A \(testes passam\)/);
  assert.match(done, /\(1\/2 done\)/);
});

test("update sem plano e etapa inexistente são recusados", async () => {
  await assert.rejects(planTool.run({ ...empty, action: "update", step: 1, status: "done" }, ctx("s-none")), /no plan in this session/);
  await planTool.run({ ...empty, action: "create", title: "P", steps: ["A", "B"] }, ctx("s-missing"));
  await assert.rejects(planTool.run({ ...empty, action: "update", step: 9, status: "done" }, ctx("s-missing")), /step 9 does not exist/);
});

test("cada sessão tem o seu plano", async () => {
  await planTool.run({ ...empty, action: "create", title: "Só desta", steps: ["X", "Y"] }, ctx("s-own"));
  await assert.rejects(planTool.run({ ...empty, action: "show" }, ctx("s-other")), /no plan in this session/);
});

test("todos os campos da ferramenta são obrigatórios, e ela fica fora da gramática estrita", () => {
  const registered = register(planTool);
  const schema = registered.definition.input_schema as { required?: string[]; properties?: Record<string, unknown> };
  assert.equal(schema.required?.length, Object.keys(schema.properties ?? {}).length);
  assert.equal(registered.definition.strict, false);
});
