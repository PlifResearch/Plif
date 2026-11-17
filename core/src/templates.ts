export const CONFIG_TEMPLATE = `# Plif configuration. Missing fields use their defaults.

model = "gpt-6-luna"               # ids in model.json; [models] main replaces it when set
model_reasoning_effort = "medium"  # low, medium, high, xhigh or max
approval_policy = "on-request"     # on-request asks. never blocks what the classifier does not allow.
sandbox_mode = "workspace-write"   # read-only, workspace-write or danger-full-access (no sandbox)

[provider]
kind = "openai"                    # openai (chat completions) or anthropic (messages)
# base_url = "https://api.openai.com/v1"
#   Any server that speaks the same format: OpenAI, OpenRouter, vLLM, LM Studio, Ollama...
#   Unset = the official URL of the kind. Examples:
#   "https://openrouter.ai/api/v1", "http://localhost:8000/v1" (vLLM),
#   "http://localhost:1234/v1" (LM Studio), "http://localhost:11434/v1" (Ollama)
# api_key = ""                     # the key itself. Optional; read before api_key_env and the system keychain.
# api_key_env = "OPENAI_API_KEY"   # variable that holds the key; unset = OPENAI_API_KEY or ANTHROPIC_API_KEY
# With kind = "openai" and a base_url other than OpenAI's, Plif asks GET {base_url}/models once without a key.
# A 200 answer means the server needs no key and Plif does not ask for one. The answer is cached for a day.

[models]
# Empty main keeps the top-level model; other empty roles use the catalog and subagent defaults.
main = ""                          # the conversation
classifier = ""                    # approves or refuses actions in auto mode
compaction = ""                    # summarizes older history when the context fills up
session_summary = ""               # short session title shown in /resume
subagent = ""                      # general subagents
explore = ""                       # read-only exploration subagents

[sandbox]
network = "allow"                  # allow or deny. deny isolates the network from shell commands.
mask_paths = ["~/.ssh", "~/.aws", "~/.gnupg"]  # these paths are empty inside the sandbox
writable_roots = []                # extra folders the sandbox may write to

[agent]
max_turns = 40                # turns allowed for one request
max_total_tokens = 2000000   # token budget for one request (cache writes and reads weighted)

[context]
compact_at_tokens = 120000   # above this estimate, older history is summarized

[git]
coauthor = "PlifResearch <github.com/PlifResearch>"  # added to commits Plif makes; "" turns it off

[web]
allowed_domains = []   # sites you released for WebFetch and WebView without asking, e.g. ["docs.python.org"]

[marketplace]
url = "https://raw.githubusercontent.com/PlifResearch/Marketplace/main/marketplace.json"  # catalogue read by /mcp

[memory]
enabled = true                     # per-project memory (MEMORY.md and topic files)

# Plif asks the first time in each folder and saves the answer here.
# [projects."/path/to/project"]
# trust_level = "trusted"
`;

export const MODEL_TEMPLATE = `${JSON.stringify(
  {
    default: "gpt-6-luna",
    classifier: "gpt-6-luna",
    models: [
      {
        id: "gpt-6-luna",
        name: "GPT-6 Luna",
        contextWindow: 400000,
        maxOutputTokens: 128000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        note: "lowest price on the OpenAI models page",
      },
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        contextWindow: 400000,
        maxOutputTokens: 128000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        note: "OpenAI's suggested general-purpose model",
      },
      {
        id: "claude-haiku-5-5",
        name: "Haiku 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        note: "needs [provider] kind = \"anthropic\"",
      },
    ],
  },
  null,
  2,
)}\n`;
