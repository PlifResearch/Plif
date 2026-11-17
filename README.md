<p align="center">
  <img src="assets/brand/plif-256.png" alt="Plif, a blue pencil" width="128">
</p>

<h1 align="center">Plif</h1>

<p align="center">A coding agent that lives in your terminal and works on your own machine.</p>

---

> **Beta (0.1.0).** Plif is not stable yet. Some things will break, some screens will change, and a few features are half done. I use it every day for real work, and you can too, as long as you keep an eye on what it does. I'm working on it constantly and new versions will come often.

## What it is

You open a terminal in a project folder, type `plif`, and ask for something: fix this test, explain this module, rename that function everywhere, find out why the build is slow. Plif reads the code, runs commands, edits files and tells you what it changed. It runs on your computer, in your folder, with your Git.

The part I care about most is control. A language model should not be the thing that decides whether `rm -rf` is fine. In Plif, that decision is made by code:

- Some actions are always blocked, whatever the model says.
- Reading inside the project is free. Writing outside it, touching protected paths or reaching the network goes through a permission check.
- When an action is unclear, a small, cheap model looks at it and answers allow, ask or deny. If it can't decide, you get asked.
- On Linux, shell commands run inside a bubblewrap sandbox that can only write to the project. `~/.ssh`, `~/.aws` and `~/.gnupg` look empty from inside it.
- Every decision is written to `~/.plif/logs/`, so you can check later what was allowed and why.

Plif knows Git. It reads the diff, the branch and the history before it touches anything, and it never commits, pushes or creates a branch unless you ask.

## What you get in this version

- A full terminal interface: markdown with syntax colors, a card for each tool call, mouse support, image paste (Ctrl+V) and image drag and drop.
- Four approval modes, switched with Shift+Tab: `auto`, `ask`, `never ask` and `read only`.
- Sessions you can resume with `/resume` or `plif --session`, searchable by title, branch and project.
- Memory per project, kept in plain Markdown files you can open and edit.
- Personal instructions in `~/.plif/PLIF.md`. The first run creates it with Plif's default instructions. Change it as you like; Plif never overwrites it.
- Project instructions from `PLIF.md` or `AGENTS.md` in the repository, loaded after you trust the folder.
- Web search and page reading, subagents for exploration, background tasks, MCP servers and hooks.
- `plif --acp` to use it from editors that speak the Agent Client Protocol, such as Zed.

## Models

Plif talks to two kinds of API:

- **Anthropic** (Messages API), with Claude models.
- **Anything OpenAI compatible**: OpenAI itself, OpenRouter, or a local server such as vLLM, LM Studio or Ollama.

You pick the provider and the model in `~/.plif/config.toml`. The file is created on the first run and every option is commented.

## Install

Plif is not on npm yet. For now you clone the repository and build it.

You need [Node.js 24](https://nodejs.org) or newer and Git. On Linux, install `bubblewrap` too if you want the sandbox (`sudo apt install bubblewrap`, `sudo dnf install bubblewrap` or `sudo pacman -S bubblewrap`).

```sh
git clone https://github.com/PlifResearch/Plif.git
cd Plif
npm install
npm run build
```

`npm run build` compiles Plif and puts a `plif` command in `~/.local/bin` (on Windows, a `plif.cmd` in `%APPDATA%\npm`). If your terminal says the command doesn't exist, add that folder to your `PATH`.

To update later:

```sh
cd Plif
git pull
npm install
npm run build
```

## First run

```sh
cd your-project
plif
```

On the first run Plif creates `~/.plif` (on Windows, `C:\Users\<you>\.plif`) with:

- `config.toml`: provider, model, sandbox and limits.
- `model.json`: the model catalog.
- `PLIF.md`: your personal instructions.

Then it asks for an API key. It reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` if they are set. Otherwise you paste the key and Plif stores it in the system keychain (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows). Local servers that don't need a key are detected and skip this step.

In a new folder Plif asks whether you trust it. Type `/` inside the interface to see the commands.

## Platforms

| | Linux | macOS | Windows |
|---|---|---|---|
| Interface | yes | yes | yes (Windows Terminal works best) |
| Shell sandbox | bubblewrap | not yet | not yet |

Without a sandbox, the header shows `sandbox off` and shell commands need your approval.

## Known gaps

- The desktop app is planned and not started. Plif is terminal only for now.
- The sandbox does not filter the network by domain. It is either on or off.
- The action classifier still needs a larger round of tests against real attempts to trick it.

If something breaks, open an [issue](https://github.com/PlifResearch/Plif/issues) with what you asked, what happened and what you expected. Logs from `~/.plif/logs/` help a lot (check them for anything private before posting).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Plif comes with no warranty. It runs commands on your machine, so review what you approve.
