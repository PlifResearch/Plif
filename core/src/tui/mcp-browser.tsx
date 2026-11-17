import { Box, Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { MarketplaceEntry } from "../marketplace.js";
import type { McpServerConfig } from "../mcp.js";
import { glyph, palette } from "./theme.js";

const TABS = ["Discover", "Installed", "Marketplace", "Errors", "Stats"] as const;
type Tab = (typeof TABS)[number];
const VISIBLE_ROWS = 6;
const NAME_WIDTH = 22;

export interface McpBrowserProps {
  readonly entries: readonly MarketplaceEntry[] | null;
  readonly loadError: string | null;
  readonly source: "network" | "cache" | null;
  readonly marketplaceUrl: string;
  readonly installed: Record<string, McpServerConfig>;
  readonly errors: readonly string[];
  readonly matches: (entry: MarketplaceEntry, query: string) => boolean;
  readonly onInstall: (entry: MarketplaceEntry) => Promise<string>;
  readonly onClose: () => void;
}

export function McpBrowser(props: McpBrowserProps): React.ReactElement {
  const { columns } = useWindowSize();
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const currentTab: Tab = TABS[tab] ?? "Discover";
  const matching = (props.entries ?? []).filter((entry) => props.matches(entry, query));
  const current = matching[selected];

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" || key.return) {
        setConfirming(false);
        if (current !== undefined) void props.onInstall(current).then(setMessage);
      } else if (input === "n" || key.escape) {
        setConfirming(false);
      }
      return;
    }
    if (key.escape) {
      if (detail) setDetail(false);
      else props.onClose();
      return;
    }
    if (detail) {
      if (input === "i" && current !== undefined) setConfirming(true);
      return;
    }
    if (key.rightArrow || key.tab) {
      setTab((index) => (index + 1) % TABS.length);
      setSelected(0);
    } else if (key.leftArrow) {
      setTab((index) => (index + TABS.length - 1) % TABS.length);
      setSelected(0);
    } else if (key.upArrow) {
      setSelected((index) => Math.max(0, index - 1));
    } else if (key.downArrow) {
      setSelected((index) => Math.min(Math.max(0, matching.length - 1), index + 1));
    } else if (key.return && currentTab === "Discover" && current !== undefined) {
      setDetail(true);
    } else if (currentTab === "Discover" && (key.backspace || key.delete)) {
      setQuery((value) => value.slice(0, -1));
      setSelected(0);
    } else if (currentTab === "Discover" && input !== "" && !key.ctrl && !key.meta) {
      setQuery((value) => value + input);
      setSelected(0);
    }
  });

  const hint = detail
    ? "i install · esc back"
    : currentTab === "Discover"
      ? "type to search · enter details · ←→ tabs · esc close"
      : "←→ tabs · esc close";

  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" paddingX={2}>
        <Text>
          <Text bold>plif</Text>
          {"  MCP servers"}
        </Text>
        {currentTab === "Discover" && !detail ? (
          <Text color={palette.meta}>{`${matching.length === 0 ? 0 : selected + 1} of ${matching.length}`}</Text>
        ) : null}
      </Box>

      <Box marginTop={1} paddingX={2}>
        {TABS.map((name, index) => (
          <Box key={name} marginRight={2}>
            <Text backgroundColor={index === tab ? palette.accent : undefined} color={index === tab ? palette.background : undefined}>
              {` ${name} `}
            </Text>
          </Box>
        ))}
      </Box>

      {currentTab === "Discover" ? (
        detail && current !== undefined ? (
          <EntryDetail entry={current} confirming={confirming} message={message} />
        ) : (
          <DiscoverList
            entries={props.entries}
            loadError={props.loadError}
            matching={matching}
            selected={selected}
            query={query}
            total={props.entries?.length ?? 0}
            installed={props.installed}
            width={columns}
          />
        )
      ) : null}

      {currentTab === "Installed" ? <InstalledView installed={props.installed} /> : null}
      {currentTab === "Marketplace" ? (
        <MarketplaceView url={props.marketplaceUrl} source={props.source} count={props.entries?.length ?? 0} />
      ) : null}
      {currentTab === "Errors" ? <ErrorsView errors={props.errors} loadError={props.loadError} /> : null}
      {currentTab === "Stats" ? (
        <StatsView
          total={props.entries?.length ?? 0}
          verified={(props.entries ?? []).filter((entry) => entry.trust === "verified").length}
          installed={Object.keys(props.installed).length}
          errors={props.errors.length}
        />
      ) : null}

      <Box marginTop={1} paddingX={2}>
        <Text color={palette.meta}>{hint}</Text>
      </Box>
    </Box>
  );
}

function DiscoverList(props: {
  readonly entries: readonly MarketplaceEntry[] | null;
  readonly loadError: string | null;
  readonly matching: readonly MarketplaceEntry[];
  readonly selected: number;
  readonly query: string;
  readonly total: number;
  readonly installed: Record<string, McpServerConfig>;
  readonly width: number;
}): React.ReactElement {
  if (props.entries === null && props.loadError === null) {
    return (
      <Box paddingX={2} marginTop={1}>
        <Text color={palette.meta}>Loading the marketplace…</Text>
      </Box>
    );
  }
  if (props.loadError !== null) {
    return (
      <Box paddingX={2} marginTop={1}>
        <Text color={palette.err}>{props.loadError}</Text>
      </Box>
    );
  }
  const start = Math.max(0, Math.min(props.selected - 2, props.matching.length - VISIBLE_ROWS));
  const visible = props.matching.slice(start, start + VISIBLE_ROWS);
  const verified = props.matching.filter((entry) => entry.trust === "verified").length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={2}>
        {props.query === "" ? (
          <Text color={palette.meta}>{glyph.search} search…</Text>
        ) : (
          <Text>
            {glyph.search} {props.query}
            <Text color={palette.accent}>█</Text>
          </Text>
        )}
      </Box>
      <Box paddingX={2} marginTop={1}>
        <Text color={palette.meta}>
          {`${props.total} servers · ${verified} verified · ${props.total - verified} community`}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Box paddingX={2}>
            <Text color={palette.meta}>No servers match this search.</Text>
          </Box>
        ) : null}
        {visible.map((entry, offset) => {
          const active = start + offset === props.selected;
          const right = [entry.trust === "verified" ? "verified" : "community", entry.maintainer, props.installed[entry.id] ? "installed" : undefined]
            .filter(Boolean)
            .join(" · ");
          const fg = active ? palette.background : undefined;
          const mutedFg = active ? palette.background : palette.meta;
          return (
            <Box key={entry.id} width={props.width} paddingX={2} backgroundColor={active ? palette.accent : undefined}>
              <Box width={NAME_WIDTH} flexShrink={0}>
                <Text color={fg} wrap="truncate-end">
                  {entry.name}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} marginRight={2}>
                <Text color={mutedFg} wrap="truncate-end">
                  {entry.description}
                </Text>
              </Box>
              <Text color={mutedFg}>{right}</Text>
            </Box>
          );
        })}
        {props.matching.length > start + VISIBLE_ROWS ? (
          <Box paddingX={2}>
            <Text color={palette.meta}>{`${props.matching.length - start - VISIBLE_ROWS} more`}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function EntryDetail(props: {
  readonly entry: MarketplaceEntry;
  readonly confirming: boolean;
  readonly message: string | null;
}): React.ReactElement {
  const { entry } = props;
  const command = [entry.install.command, ...entry.install.args].join(" ");
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Text bold>{entry.name}</Text>
      <Text color={palette.meta}>{entry.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>
          source <Text color={palette.meta}>{entry.repository}</Text>
        </Text>
        <Text>
          trust <Text color={palette.meta}>{entry.trust}</Text>
        </Text>
        <Text>
          runs <Text color={palette.meta}>{command}</Text>
        </Text>
        {entry.env.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text>needs environment variables (read from your shell, not stored):</Text>
            {entry.env.map((variable) => (
              <Text key={variable.name} color={palette.meta}>
                {"  "}
                {variable.name}: {variable.description}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      {props.confirming ? (
        <Box marginTop={1}>
          <Text color={palette.warn}>Install and add it to mcp.json? y/enter confirms · n cancels</Text>
        </Box>
      ) : null}
      {props.message !== null ? (
        <Box marginTop={1}>
          <Text>{props.message}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function InstalledView({ installed }: { readonly installed: Record<string, McpServerConfig> }): React.ReactElement {
  const names = Object.keys(installed);
  if (names.length === 0) {
    return (
      <Box paddingX={2} marginTop={1}>
        <Text color={palette.meta}>No servers in mcp.json yet. Open Discover to add one.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      {names.map((name) => {
        const server = installed[name];
        return (
          <Text key={name}>
            {name} <Text color={palette.meta}>· {server?.trust ?? "local"} · {server === undefined ? "" : "url" in server ? server.url : server.command}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function MarketplaceView(props: {
  readonly url: string;
  readonly source: "network" | "cache" | null;
  readonly count: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Text>
        catalogue <Text color={palette.meta}>{props.url}</Text>
      </Text>
      <Text color={palette.meta}>
        {props.count} entries · {props.source === null ? "loading" : props.source === "cache" ? "from cache (up to 1 hour old)" : "fresh from GitHub"}
      </Text>
    </Box>
  );
}

function ErrorsView(props: { readonly errors: readonly string[]; readonly loadError: string | null }): React.ReactElement {
  const all = [...(props.loadError === null ? [] : [props.loadError]), ...props.errors];
  if (all.length === 0) {
    return (
      <Box paddingX={2} marginTop={1}>
        <Text color={palette.meta}>No errors.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      {all.map((line, index) => (
        <Text key={index} color={palette.err}>
          {truncate(line, 120)}
        </Text>
      ))}
    </Box>
  );
}

function StatsView(props: { readonly total: number; readonly verified: number; readonly installed: number; readonly errors: number }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Text>entries {props.total}</Text>
      <Text>verified {props.verified}</Text>
      <Text>installed {props.installed}</Text>
      <Text>errors {props.errors}</Text>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
