const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HEAD_SHARE = 0.6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function stripAnsi(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.split("\r").pop() ?? "")
    .join("\n");
}

export function collapseRepeats(text: string, minRun = 3): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    let end = index;
    while (end + 1 < lines.length && lines[end + 1] === line) end++;
    const run = end - index + 1;
    if (run >= minRun) out.push(`${line}  [repeated ${run} times]`);
    else for (let copy = 0; copy < run; copy++) out.push(line);
    index = end + 1;
  }
  return out.join("\n");
}

export function limitOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * HEAD_SHARE);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[... ${omitted} characters omitted from the middle; narrow the request to see them ...]\n${text.slice(-tail)}`;
}
