import { readFileSync } from "node:fs";

/**
 * Read `.env.local` the way dotenv does.
 *
 * Playwright specs cannot use `process.env` — the dev server is started with dotenv, but the test
 * process itself is not — so they parse the file directly. The parsing that matters is the quote
 * stripping: `.env.local` quotes its values, dotenv strips those quotes, and a naive
 * `split("=")` does not. Without this the email filled into the sign-in form is
 * `"owner@localhost.test"` INCLUDING the quotes, every sign-in fails, and every test times out on
 * a page that never navigates — which reads as a broken app rather than a broken parser.
 *
 * One copy, because five hand-rolled parsers drift and this one already had.
 */
export function readEnvLocal(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        const key = line.slice(0, at).trim();
        const raw = line.slice(at + 1).trim();
        const unquoted =
          (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
          (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
            ? raw.slice(1, -1)
            : raw;
        return [key, unquoted];
      }),
  );
}
