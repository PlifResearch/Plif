import path from "node:path";

const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "exec",
  "builtin",
  "xargs",
  "stdbuf",
  "ionice",
  "timeout",
]);
const WRAPPER_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "-g",
  "-C",
  "-p",
  "-r",
  "-t",
  "-T",
  "-n",
  "-s",
  "-k",
  "-I",
  "-P",
  "-L",
  "-d",
  "-E",
  "-a",
]);

export function programName(token: string | undefined): string {
  return token === undefined ? "" : path.posix.basename(token);
}

export function unwrap(argv: readonly string[]): string[] {
  const rest = [...argv];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      rest.shift();
      continue;
    }
    const name = programName(head);
    if (!WRAPPERS.has(name)) return rest;
    rest.shift();
    while (rest[0]?.startsWith("-")) {
      const flag = rest.shift();
      if (flag !== undefined && WRAPPER_OPTIONS_WITH_VALUE.has(flag)) rest.shift();
    }
    if (name === "timeout") rest.shift();
  }
}

export function hasShortFlag(args: readonly string[], letter: string): boolean {
  return args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes(letter));
}

export function hasLongFlag(args: readonly string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function positional(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}
