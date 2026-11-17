import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { installServer, loadMarketplace, parseMarketplace, searchEntries, serverFromEntry, type MarketplaceEntry } from "../src/marketplace.js";
import { McpBrowser } from "../src/tui/mcp-browser.js";

const exa: MarketplaceEntry = {
  id: "exa",
  name: "Exa",
  description: "Web search and page reading for coding agents",
  repository: "https://github.com/exa-labs/exa-mcp-server",
  transport: "stdio",
  install: { command: "npx", args: ["-y", "exa-mcp-server@3.1.0"] },
  env: [{ name: "EXA_API_KEY", description: "your Exa key", secret: true }],
  maintainer: "exa-labs",
  trust: "verified",
};
const community: MarketplaceEntry = { ...exa, id: "notes", name: "Notes", description: "Keeps notes", maintainer: "someone", trust: "community", env: [] };

const catalogue = JSON.stringify({ version: 1, entries: [exa, community] });

test("catálogo inválido é recusado", () => {
  assert.equal(parseMarketplace(catalogue).length, 2);
  assert.throws(() => parseMarketplace(JSON.stringify({ version: 2, entries: [] })));
  assert.throws(() => parseMarketplace(JSON.stringify({ version: 1, entries: [{ ...exa, install: { command: "", args: [] } }] })));
  assert.throws(() => parseMarketplace(JSON.stringify({ version: 1, entries: [{ ...exa, env: [{ name: "lower", description: "x" }] }] })));
});

test("busca por palavras em todos os campos", () => {
  assert.deepEqual(searchEntries([exa, community], "exa").map((entry) => entry.id), ["exa"]);
  assert.deepEqual(searchEntries([exa, community], "keeps").map((entry) => entry.id), ["notes"]);
  assert.equal(searchEntries([exa, community], "").length, 2);
});

test("servidor instalado guarda só a referência à variável, nunca o valor", async () => {
  const server = serverFromEntry(exa);
  assert.deepEqual(server.env, { EXA_API_KEY: "$EXA_API_KEY" });
  assert.equal(server.trust, "verified");

  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-market-")));
  const file = path.join(dir, "mcp.json");
  await writeFile(file, JSON.stringify({ servers: { other: { command: "node", args: [] } } }));
  await installServer(file, "exa", server);
  const saved = JSON.parse(await readFile(file, "utf8")) as { servers: Record<string, unknown> };
  assert.ok(saved.servers.other, "existing servers are kept");
  assert.deepEqual(saved.servers.exa, { command: "npx", args: ["-y", "exa-mcp-server@3.1.0"], env: { EXA_API_KEY: "$EXA_API_KEY" }, allow: [], trust: "verified" });
  assert.doesNotMatch(await readFile(file, "utf8"), /sk-|secret-value/);
});

test("catálogo vem do cache dentro de uma hora e cai para o cache quando a rede falha", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "plif-cache-")));
  const cache = path.join(dir, "marketplace.json");
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(catalogue, { status: 200 });
  }) as unknown as typeof fetch;
  const first = await loadMarketplace("https://example.test/m.json", cache, { fetch: fetcher, now: () => 1_000 });
  assert.equal(first.source, "network");
  const second = await loadMarketplace("https://example.test/m.json", cache, { fetch: fetcher, now: () => 2_000 });
  assert.equal(second.source, "cache");
  assert.equal(calls, 1);

  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const later = await loadMarketplace("https://example.test/m.json", cache, { fetch: failing, now: () => 1_000 + 2 * 60 * 60 * 1000 });
  assert.equal(later.source, "cache");
  assert.equal(later.entries.length, 2);
});

const noop = async () => "";

test("/mcp: abas, lista com marcador, busca e detalhe com variáveis", async () => {
  const { lastFrame, stdin, unmount } = render(
    <McpBrowser
      entries={[exa, community]}
      loadError={null}
      source="cache"
      marketplaceUrl="https://example.test/m.json"
      installed={{}}
      errors={[]}
      matches={(entry, query) => searchEntries([entry], query).length === 1}
      onInstall={noop}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /Discover/);
  assert.match(frame, /Installed/);
  assert.match(frame, /plif {2}MCP servers/);
  assert.match(frame, /1 of 2/);
  assert.match(frame, /Exa/);
  assert.match(frame, /verified/);
  assert.match(frame, /type to search/);

  stdin.write("notes");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(lastFrame() ?? "", /1 of 1/);
  assert.match(lastFrame() ?? "", /Notes/);
  unmount();
});
