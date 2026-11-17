#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { plifHomeDir } from "./home.js";
import { App, type InitialSession } from "./tui/App.js";
import { buildRuntime } from "./runtime.js";
import { isTrusted, loadConfig } from "./config.js";
import { ensureHome, homeLayout } from "./home.js";
import path from "node:path";
import { ensureApiKey, platformKeyStore, providerKeyOptions } from "./api-key.js";
import { cleanOldScratch } from "./scratch.js";
import { serveAcp } from "./acp.js";
import { KeySetup } from "./tui/key-setup.js";
import type { SessionEntry } from "./session.js";
import { SessionPicker } from "./tui/session-picker.js";
import { supportsMouse } from "./tui/terminal.js";
import type { Runtime } from "./runtime.js";

const HELP = `plif: coding agent that runs on your computer.

usage:
  plif                   opens the interface in the current folder
  plif --session         picks a session from this project to continue
  plif --session <id>    continues the session with that id (or its start)
  plif --acp             runs as an Agent Client Protocol agent on stdin and stdout (for editors such as Zed)
  plif --version         shows the version
  plif --help            shows this help

inside the interface, type / to see the commands.
configuration: ~/.plif/config.toml (or $PLIF_HOME)`;

// The editor owns stdin and stdout, so nothing is asked and nothing else is printed there. Logs go to stderr.
async function runAcp(): Promise<void> {
  const home = plifHomeDir();
  const layout = homeLayout(home);
  await ensureHome(layout);
  const config = await loadConfig(layout.config);
  const keyOptions = providerKeyOptions(config.provider, path.join(layout.root, "provider-probe.json"));
  const setup = await ensureApiKey({ ...keyOptions, env: process.env, store: platformKeyStore(), ask: async () => null });
  if (setup === null) console.error(`plif --acp: no API key found; set ${keyOptions.envName} or run plif once in a terminal to save it`);
  await serveAcp({ input: process.stdin, output: process.stdout, homeRoot: home });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--version")) {
    console.log("plif 0.1.0");
    return;
  }
  if (args.includes("--acp")) {
    await runAcp();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Plif needs an interactive terminal.");
    process.exitCode = 1;
    return;
  }

  const home = plifHomeDir();
  const layout = homeLayout(home);
  await ensureHome(layout);
  const config = await loadConfig(layout.config);
  const keyOptions = providerKeyOptions(config.provider, path.join(layout.root, "provider-probe.json"));
  const envName = keyOptions.envName;
  const store = platformKeyStore();
  const storage = store?.label ?? "no keychain available: the key is valid for this session only";
  const setup = await ensureApiKey({ ...keyOptions, env: process.env, store, ask: askKey(envName, storage) });
  if (setup === null) return;
  if (setup.source === "typed" && setup.persisted) console.log(`key saved in ${storage}.`);
  if (setup.source === "typed" && !setup.persisted) console.log("the key is valid for this session only.");

  const runtime = await buildRuntime(process.cwd(), home);
  void cleanOldScratch().catch(() => 0);
  let initialSession: InitialSession | undefined;
  const sessionAt = args.indexOf("--session");
  if (sessionAt !== -1) {
    const requested = args[sessionAt + 1];
    if (requested !== undefined && !requested.startsWith("-")) {
      initialSession = await loadProjectSession(runtime, requested);
    } else {
      const sessions = await runtime.sessions.list();
      if (sessions.length === 0) throw new Error("no sessions yet");
      const picked = await pickSession(runtime, sessions);
      if (picked === null) return;
      // A session from another project runs there, with that folder's trust, instructions and memory.
      if (picked.cwd !== runtime.root) {
        console.log(`this session belongs to ${picked.cwd}. To continue: cd ${JSON.stringify(picked.cwd)} && plif --session ${picked.id.slice(0, 8)}`);
        return;
      }
      initialSession = await runtime.sessions.load(picked.id);
    }
  }
  for (const message of [...runtime.mcpErrors, ...runtime.skillErrors, ...runtime.hooks.warnings]) console.error(message);
  let lastSession = initialSession?.meta.id ?? "";
  // Ink asks the terminal about the kitty keyboard protocol on the first frame, before its input hooks turn
  // raw mode on. With echo still on, the reply (ESC [ ? 0 u) would be printed on screen as "^[[?0u".
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const app = render(
    <App
      runtime={runtime}
      trusted={isTrusted(runtime.config, runtime.root)}
      initialSession={initialSession}
      onSessionChange={(id) => {
        lastSession = id;
      }}
    />,
    // The kitty keyboard protocol reports modifiers on Enter, so Shift+Enter can differ from Enter.
    // "auto" turns it on only in terminals that answer the query.
    { alternateScreen: true, kittyKeyboard: { mode: "auto", flags: ["disambiguateEscapeCodes"] } },
  );
  // Everything on the alternate screen belongs to Plif, so a resize wipes it whole and Ink draws a fresh frame.
  // Counting lines to erase is what leaves copies behind when the terminal rewraps them.
  const wipe = () => {
    app.clear();
    process.stdout.write("\x1b[H\x1b[J");
  };
  process.stdout.prependListener("resize", wipe);
  // SGR mouse reports with motion (1000, 1003, 1006): clicks open tool cards, the pointer lights them, the wheel scrolls.
  // Shift+drag still selects text in most terminals. On Windows only Windows Terminal reports them on stdin.
  const mouse = supportsMouse();
  const mouseOff = () => {
    if (mouse) process.stdout.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l");
  };
  if (mouse) process.stdout.write("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
  // modifyOtherKeys level 1: xterm, iTerm2 and others then report Shift+Enter apart from Enter. Off again on exit.
  process.stdout.write("\x1b[>4;1m");
  process.once("exit", () => process.stdout.write("\x1b[>4;0m"));
  process.once("exit", mouseOff);
  await app.waitUntilExit();
  mouseOff();
  process.stdout.off("resize", wipe);
  if (lastSession !== "" && runtime.hooks.has("SessionEnd")) {
    const transcriptPath = path.join(runtime.layout.sessions, lastSession, "transcript.jsonl");
    const ended = await runtime.hooks.fire("SessionEnd", "prompt_input_exit", { session: lastSession, cwd: runtime.root, transcriptPath }, { reason: "prompt_input_exit" });
    for (const message of ended.messages) console.error(message);
  }
  await runtime.dispose();
  // The alternate screen disappears on exit, so the way back to the session is printed on the normal screen.
  if (lastSession !== "") console.log(`session ${lastSession.slice(0, 8)} · to continue: plif --session ${lastSession.slice(0, 8)}`);
}

// Each attempt draws its own screen, so a rejected key shows the reason above a fresh prompt.
function askKey(envName: string, storage: string): (problem: string | null) => Promise<string | null> {
  return (problem) =>
    new Promise((resolve) => {
      const screen = render(
        <KeySetup
          envName={envName}
          problem={problem}
          storage={storage}
          onSubmit={(key) => {
            screen.unmount();
            resolve(key);
          }}
          onCancel={() => {
            screen.unmount();
            resolve(null);
          }}
        />,
      );
    });
}

async function loadProjectSession(runtime: Runtime, prefix: string): Promise<InitialSession> {
  const loaded = await runtime.sessions.load(prefix);
  if (loaded.meta.cwd !== runtime.root) throw new Error("this session belongs to another project");
  return loaded;
}

// Shows the picker on the normal screen and resolves with the chosen session id, or null on Esc.
function pickSession(runtime: Runtime, sessions: readonly SessionEntry[]): Promise<SessionEntry | null> {
  return new Promise((resolve) => {
    const picker = render(
      <SessionPicker
        sessions={sessions}
        cwd={runtime.root}
        branch={runtime.git?.branch ?? null}
        onPreview={(id) => runtime.sessions.preview(id)}
        onRename={async (id, title) => {
          await runtime.sessions.rename(id, title);
        }}
        onPick={(session) => {
          picker.unmount();
          resolve(session);
        }}
      />,
    );
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
