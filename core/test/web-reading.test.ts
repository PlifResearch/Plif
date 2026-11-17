import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { htmlToMarkdown } from "../src/net/readable.js";
import { checkRobots, clearRobotsCache, isPathAllowed, parseRobots } from "../src/net/robots.js";
import { type BrowserHost, chromeArgs, findBrowser, publicAddressFor, renderPage, startGuardProxy } from "../src/web/browser.js";
import { parseDuckDuckGoLite, search } from "../src/web/search.js";
import type { FetchedPage } from "../src/net/fetch-page.js";

test("robots.txt: o grupo da Plif vence o *, a regra mais longa decide e Allow vence empate", () => {
  const rules = parseRobots(`
User-agent: *
Disallow: /

User-agent: Plif
User-agent: OtherBot
Disallow: /private
Allow: /private/open
Disallow: /*.pdf$
Allow: /tie
Disallow: /tie
`);
  assert.equal(isPathAllowed(rules, "/docs").allowed, true);
  assert.equal(isPathAllowed(rules, "/private/x").allowed, false);
  assert.equal(isPathAllowed(rules, "/private/open/x").allowed, true);
  assert.equal(isPathAllowed(rules, "/files/a.pdf").allowed, false);
  assert.equal(isPathAllowed(rules, "/files/a.pdf?x=1").allowed, true);
  assert.equal(isPathAllowed(rules, "/tie").allowed, true);

  const generic = parseRobots("User-agent: *\nDisallow: /cgi-bin/\nDisallow:\n");
  assert.equal(isPathAllowed(generic, "/").allowed, true);
  assert.equal(isPathAllowed(generic, "/cgi-bin/run").allowed, false);
  assert.equal(isPathAllowed(parseRobots("User-agent: *\nDisallow: /caf%C3%A9"), "/caf%c3%a9/menu").allowed, false);
});

function page(body: string): FetchedPage {
  return { requestedUrl: "", finalUrl: "", contentType: "text/plain", body, truncated: false };
}

test("robots.txt: 404 libera, 5xx e falha de rede fecham, e a resposta fica em cache por origem", async () => {
  clearRobotsCache();
  let loads = 0;
  const notFound = async () => {
    loads++;
    throw new Error("HTTP 404");
  };
  assert.equal((await checkRobots(new URL("https://a.example/x"), { load: notFound })).allowed, true);
  assert.equal((await checkRobots(new URL("https://a.example/y"), { load: notFound })).allowed, true);
  assert.equal(loads, 1);

  const down = async (): Promise<FetchedPage> => {
    throw new Error("HTTP 503");
  };
  const closed = await checkRobots(new URL("https://b.example/x"), { load: down });
  assert.equal(closed.allowed, false);
  assert.match(closed.reason, /could not be read/);

  const blocking = async () => page("User-agent: *\nDisallow: /admin");
  assert.equal((await checkRobots(new URL("https://c.example/admin/panel"), { load: blocking })).allowed, false);
  let now = 0;
  const open = async () => page("");
  await checkRobots(new URL("https://d.example/"), { load: open, now: () => now });
  now = 2 * 60 * 60 * 1000;
  assert.equal((await checkRobots(new URL("https://d.example/admin"), { load: blocking, now: () => now })).allowed, false);
  clearRobotsCache();
});

test("Readability: artigo vira Markdown sem scripts, com título, lista e link absoluto", () => {
  const paragraph = "Plif reads pages and keeps only what matters for the task at hand. ".repeat(6);
  const html = `<html><head><title>Guide | Site</title><script>alert(1)</script></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article><h1>Guide</h1><h2>Setup</h2><p>${paragraph}</p><p>See <a href="/docs/start">the docs</a>.</p>
    <ul><li>one</li><li>two</li></ul><pre><code>npm test</code></pre></article>
    <footer>© 2026</footer></body></html>`;
  const result = htmlToMarkdown(html, "https://site.example/guide");
  assert.equal(result.extraction, "readability");
  assert.match(result.markdown, /## Setup/);
  assert.match(result.markdown, /\[the docs\]\(https:\/\/site\.example\/docs\/start\)/);
  assert.match(result.markdown, /- one\n- two/);
  assert.match(result.markdown, /```\nnpm test\n```/);
  assert.doesNotMatch(result.markdown, /alert|About/);
});

test("Readability: página curta cai na conversão do corpo inteiro e junta letras soltas", () => {
  const html = `<html><head><title>Sofi</title></head><body><h1>${[..."powered"].map((letter) => `<div>${letter}</div>`).join("")}</h1><p>feel better</p></body></html>`;
  const result = htmlToMarkdown(html, "https://sofi.example/");
  assert.equal(result.extraction, "full");
  assert.equal(result.title, "Sofi");
  assert.match(result.markdown, /powered/);
  assert.match(result.markdown, /feel better/);
});

const LITE = `
<table>
 <tr><td valign="top">1.&nbsp;</td><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&amp;rut=abc" class='result-link'>Fetch &amp; timeout</a>
 </td></tr>
 <tr><td>&nbsp;</td><td class='result-snippet'>
   although the <b>&#x27;fetch&#x27;</b> call is rejected
 </td></tr>
 <tr><td>&nbsp;</td><td><span class='link-text'>example.org/a</span></td></tr>
 <tr class="result-sponsored"><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>Ad</a></td></tr>
 <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://example.net/b" class='result-link'>Second</a></td></tr>
 <tr><td>&nbsp;</td><td class='result-snippet'>other snippet</td></tr>
</table>`;

test("DuckDuckGo Lite: desembrulha o link, pula anúncios e lê título e trecho", () => {
  const results = parseDuckDuckGoLite(LITE);
  assert.deepEqual(
    results.map((result) => [result.title, result.url, result.snippet]),
    [
      ["Fetch & timeout", "https://example.org/a", "although the 'fetch' call is rejected"],
      ["Second", "https://example.net/b", "other snippet"],
    ],
  );
});

test("busca web: desafio anti-bot no HTML passa para o Lite", async () => {
  const asked: string[] = [];
  const fake = (async (url: string | URL | Request) => {
    const href = String(url);
    asked.push(new URL(href).host);
    return new Response(href.includes("html.duckduckgo") ? "<div class='anomaly-modal'></div>" : LITE, { status: 200 });
  }) as typeof fetch;
  const outcome = await search("web", `lite fallback ${Date.now()}`, { fetch: fake, sleep: async () => {} });
  assert.equal(outcome.provider, "duckduckgo-lite");
  assert.equal(outcome.results.length, 2);
  assert.deepEqual(asked, ["html.duckduckgo.com", "lite.duckduckgo.com"]);
});

function host(files: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", dirs: Record<string, string[]> = {}): BrowserHost {
  return { platform, env, home: "/home/u", isFile: (file) => files.includes(file), listDir: async (dir) => dirs[dir] ?? [] };
}

test("navegador: variável explícita, depois o instalado, depois o cache do Playwright mais novo", async () => {
  const env = { PATH: "/usr/local/bin:/usr/bin:relative" };
  assert.equal(await findBrowser(host(["/usr/bin/google-chrome-stable", "/usr/bin/chromium"], env)), "/usr/bin/google-chrome-stable");
  assert.equal(await findBrowser(host(["/opt/x/chrome"], { ...env, PLIF_BROWSER_PATH: "/opt/x/chrome" })), "/opt/x/chrome");
  assert.equal(await findBrowser(host([], { ...env, PLIF_BROWSER_PATH: "/missing" })), null);

  const cache = "/home/u/.cache/ms-playwright";
  const built = `${cache}/chromium-1248/chrome-linux64/chrome`;
  assert.equal(
    await findBrowser(host([built, `${cache}/chromium-1243/chrome-linux64/chrome`], env, "linux", { [cache]: ["ffmpeg-1011", "chromium-1243", "chromium-1248"] })),
    built,
  );
  assert.equal(await findBrowser(host([], env)), null);

  const edge = path.win32.join("C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(await findBrowser(host([edge], { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, "win32")), edge);
  assert.equal(
    await findBrowser(host(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"], {}, "darwin")),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("navegador: todo tráfego passa pelo proxy, inclusive localhost, sem porta de depuração aberta", () => {
  const args = chromeArgs("/tmp/profile", "http://127.0.0.1:9");
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:9"));
  assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(!args.some((arg) => arg.startsWith("--remote-debugging-port") || arg === "--no-sandbox"));
});

test("proxy de guarda: recusa endereços locais, privados e nomes que resolvem para a rede interna", async () => {
  await assert.rejects(publicAddressFor("localhost"), /blocked local/);
  await assert.rejects(publicAddressFor("10.0.0.8"), /blocked private/);
  await assert.rejects(publicAddressFor("[::1]"), /blocked private/);
  await assert.rejects(publicAddressFor("rebind.example", async () => ["93.184.216.34", "127.0.0.1"]), /blocked private/);
  assert.equal(await publicAddressFor("ok.example", async () => ["93.184.216.34"]), "93.184.216.34");

  const target = http.createServer((_, response) => response.end("secret"));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const port = (target.address() as net.AddressInfo).port;
  const proxy = await startGuardProxy(async (name) => (name === "inside.example" ? ["127.0.0.1"] : ["93.184.216.34"]));
  try {
    const proxyPort = Number(new URL(proxy.url).port);
    const tunnel = await new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT inside.example:${port} HTTP/1.1\r\nHost: inside.example\r\n\r\n`));
      socket.once("data", (data) => {
        resolve(data.toString());
        socket.destroy();
      });
    });
    assert.match(tunnel, /^HTTP\/1\.1 403/);
    const plain = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: proxyPort, path: `http://127.0.0.1:${port}/` }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    assert.equal(plain, 403);
    assert.equal(proxy.blocked.length, 2);
  } finally {
    await proxy.close();
    target.close();
  }
});

// Real browser and real network: opt-in, like the real keystore test.
test("WebView real: abre uma página pública e tira as fotos pedidas", { skip: process.env["PLIF_BROWSER_TEST"] !== "1" }, async () => {
  const rendered = await renderPage("https://example.com/", { shots: [1, 2], acceptHost: () => false });
  assert.equal(rendered.shots.length, 2);
  assert.ok(rendered.shots.every((shot) => shot.jpeg.subarray(0, 2).toString("hex") === "ffd8"));
  assert.match(rendered.html, /Example Domain/);

  // The real browser must not reach a server on loopback: the proxy refuses it and the navigation fails.
  const local = http.createServer((_, response) => response.end("<title>inside</title>secret"));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const port = (local.address() as net.AddressInfo).port;
  try {
    await assert.rejects(renderPage(`http://127.0.0.1:${port}/`, { shots: [0], acceptHost: () => true }), /could not open the page/);
  } finally {
    local.close();
  }
});
