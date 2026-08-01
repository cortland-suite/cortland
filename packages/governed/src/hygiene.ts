const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // generic api key style
  /\bghp_[A-Za-z0-9]{20,}\b/, // github token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // slack token
  /\bAKIA[0-9A-Z]{16}\b/, // aws access key id
  /\b(?:password|passwd|secret|token|api[_-]?key)=[^\s]+/i,
];

export function findSecretsInArgv(argv: string[]): string[] {
  const hits: string[] = [];
  for (const arg of argv) {
    for (const pattern of SECRET_PATTERNS) {
      const match = arg.match(pattern);
      if (match) {
        hits.push(`${match[0].slice(0, 6)}…`);
        break;
      }
    }
  }
  return hits;
}

/**
 * Secrets belong in the Keychain or env files outside the repo — never on the
 * command line, where they leak into shell history and process listings. The
 * framework refuses to start rather than normalize the practice.
 */
export function assertCleanArgv(argv: string[]): void {
  const hits = findSecretsInArgv(argv);
  if (hits.length > 0) {
    throw new Error(
      `Refusing to start: credential-shaped value(s) detected in argv (${hits.join(
        ", "
      )}). Use the macOS Keychain or an env file outside the repo.`
    );
  }
}
