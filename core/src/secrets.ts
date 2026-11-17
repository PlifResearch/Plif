const PATTERNS = [
  "sk-ant-[A-Za-z0-9_-]{10,}",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
];

export function containsSecret(text: string): boolean {
  return PATTERNS.some((source) => new RegExp(source).test(text));
}

export function maskSecrets(text: string): string {
  return PATTERNS.reduce((acc, source) => acc.replace(new RegExp(source, "g"), "[secret]"), text);
}
