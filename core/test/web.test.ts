import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicAddress } from "../src/net/address.js";
import { htmlToText } from "../src/net/html.js";
import { fetchPage } from "../src/net/fetch-page.js";
import { parseArxiv, parseDuckDuckGo, parseWikipedia } from "../src/web/search.js";
import { TOOLS } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

test("endereços locais, privados e de metadados são recusados", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("HTML vira texto sem scripts, estilos nem entidades crus", () => {
  const page = htmlToText(
    "<html><head><title>Plif &amp; co</title><style>p{color:red}</style></head><body><script>alert(1)</script><h1>Olá</h1><p>Um &lt;b&gt; &#233;</p><br>fim</body></html>",
  );
  assert.equal(page.title, "Plif & co");
  assert.equal(page.text, "Olá\n\nUm <b> é\n\nfim");
});

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

test("redirecionamento para host privado é recusado antes de qualquer conexão", async () => {
  const seen: string[] = [];
  const resolve = async (host: string) => (host === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
  await assert.rejects(
    fetchPage("https://site.example/a", {
      resolve,
      acceptRedirectHost: () => true,
      send: async (url) => {
        seen.push(url.href);
        return response(302, "", { location: "https://evil.example/secret" });
      },
    }),
    /blocked private address/,
  );
  assert.deepEqual(seen, ["https://site.example/a"]);
});

test("redirecionamento para outro host só segue se o host for aceito", async () => {
  const resolve = async () => ["93.184.216.34"];
  const send = async (url: URL) =>
    url.host === "a.example" ? response(301, "", { location: "https://b.example/page" }) : response(200, "<p>ok</p>");
  await assert.rejects(fetchPage("https://a.example/", { resolve, send }), /was not approved/);
  const page = await fetchPage("https://a.example/", { resolve, send, acceptRedirectHost: (host) => host === "b.example" });
  assert.equal(page.finalUrl, "https://b.example/page");
});

test("IP literal privado é recusado sem consultar DNS", async () => {
  await assert.rejects(
    fetchPage("http://169.254.169.254/latest/meta-data", { send: async () => response(200, "x") }),
    /blocked private address/,
  );
});

test("tipo de conteúdo fora da lista é recusado", async () => {
  await assert.rejects(
    fetchPage("https://a.example/file.bin", {
      resolve: async () => ["93.184.216.34"],
      send: async () => response(200, "binary", { "content-type": "application/octet-stream" }),
    }),
    /unsupported content type/,
  );
});

test("DuckDuckGo: desembrulha o link, pula anúncios e lê título e trecho", () => {
  const html = `
  <div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=x">Exemplo &amp; A</a></h2>
    <a class="result__snippet">Um trecho <b>útil</b>.</a></div>
  <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a><a class="result__snippet">patrocinado</a></div>
  <div class="result"><a class="result__a" href="https://example.net/b">Segundo</a><div class="result__snippet">outro trecho</div></div>`;
  const results = parseDuckDuckGo(html);
  assert.deepEqual(results.map((result) => result.url), ["https://example.org/a", "https://example.net/b"]);
  assert.equal(results[0]?.title, "Exemplo & A");
  assert.equal(results[0]?.snippet, "Um trecho útil.");
});

test("Wikipedia, arXiv: parsers de amostra", () => {
  const wiki = parseWikipedia(JSON.stringify({ query: { search: [{ title: "Lisboa Central", snippet: "<span>cidade</span> &amp; rio" }] } }), "pt");
  assert.deepEqual(wiki[0], {
    title: "Lisboa Central",
    url: "https://pt.wikipedia.org/wiki/Lisboa_Central",
    snippet: "cidade & rio",
    source: "wikipedia-pt",
  });
  const atom = `<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>Agents
  that plan</title><summary>We study planning.</summary></entry></feed>`;
  assert.deepEqual(parseArxiv(atom), [
    { title: "Agents that plan", url: "http://arxiv.org/abs/2401.00001v1", snippet: "We study planning.", source: "arxiv" },
  ]);
});

function ctx(webDomains: readonly string[] = []): ToolContext {
  return {
    root: "/tmp/project",
    home: "/tmp/home",
    session: "web",
    sandbox: null,
    mode: { approval: "on-request", readOnly: false },
    readFiles: new Set(),
    approver: { ask: async () => "deny" as const },
    log: { record: async () => {} },
    webDomains,
  };
}

test("WebFetch: domínio liberado segue, desconhecido pede aprovação, local é negado", async () => {
  const tool = TOOLS.find((registered) => registered.name === "WebFetch");
  if (tool === undefined) throw new Error("WebFetch missing");
  const policyFor = (url: string, domains: readonly string[]) => {
    const parsed = tool.parse({ url });
    if (!parsed.ok) throw new Error(parsed.message);
    return tool.policy(parsed.data, ctx(domains));
  };
  assert.equal((await policyFor("https://docs.example.org/x", ["docs.example.org"])).decision, "allow");
  assert.equal((await policyFor("https://other.example.org/x", [])).decision, "ask_user");
  assert.equal((await policyFor("http://127.0.0.1:8080/", [])).decision, "deny");
  assert.equal((await policyFor("file:///etc/passwd", [])).decision, "deny");
});

test("WebSearch: consulta com segredo é negada e consulta comum é permitida", async () => {
  const tool = TOOLS.find((registered) => registered.name === "WebSearch");
  if (tool === undefined) throw new Error("WebSearch missing");
  const check = async (query: string) => {
    const parsed = tool.parse({ query, scope: "web" });
    if (!parsed.ok) throw new Error(parsed.message);
    return (await tool.policy(parsed.data, ctx())).decision;
  };
  assert.equal(await check("node fetch timeout"), "allow");
  assert.equal(await check("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), "deny");
});
