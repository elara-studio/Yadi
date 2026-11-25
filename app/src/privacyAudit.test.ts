import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Privacy audit (rule D12): no TypeScript code passes a transcript, prompt, attachment text or
 * audio to a logger. The scanner reads every non-test source file, finds each logging call and
 * rejects it if an argument *expression* (string contents are ignored) names such data.
 */

const ROOT = resolve(__dirname, "../..");
const SOURCE_DIRS = ["app/src", "packages/core/src", "eval/src", "eval/run.ts"];
const LOG_CALL = /(?:console\.(?:log|info|warn|error|debug|trace)|\.log|logger\.\w+)\s*\(/g;
const SENSITIVE =
  /\b(transcript|prompt|partial|clean_text|stage0_text|preview|attachmentText|audio|samples|vocabulary)\b|\.text\b|\btext\b/;

/** Removes string contents, keeping the `${...}` expressions of template literals. */
export function expressionsOnly(args: string): string {
  let out = "";
  let i = 0;
  while (i < args.length) {
    const c = args[i]!;
    if (c === '"' || c === "'") {
      i++;
      while (i < args.length && args[i] !== c) i += args[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "`") {
      i++;
      while (i < args.length && args[i] !== "`") {
        if (args[i] === "\\") i += 2;
        else if (args[i] === "$" && args[i + 1] === "{") {
          let depth = 1;
          let j = i + 2;
          while (j < args.length && depth > 0) {
            if (args[j] === "{") depth++;
            if (args[j] === "}") depth--;
            j++;
          }
          out += ` ${args.slice(i + 2, j - 1)} `;
          i = j;
        } else i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The arguments text of each logging call in `source` (balanced parentheses). */
export function logCallArguments(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(LOG_CALL)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      if (source[i] === ")") depth--;
      i++;
    }
    found.push(source.slice(start, i - 1));
  }
  return found;
}

export function violations(source: string): string[] {
  return logCallArguments(source).filter((args) => SENSITIVE.test(expressionsOnly(args)));
}

function sourceFiles(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const p = join(full, entry.name);
    if (entry.isDirectory())
      return entry.name === "generated" ? [] : sourceFiles(relative(ROOT, p));
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [p] : [];
  });
}

describe("the scanner itself", () => {
  it("flags logging of a transcript, prompt, text or audio expression", () => {
    expect(violations("console.log(transcript)")).toHaveLength(1);
    expect(violations("ports.log(`got ${result.prompt}`)")).toHaveLength(1);
    expect(violations("this.ports.log(snapshot.text)")).toHaveLength(1);
    expect(violations('console.info("x", partial)')).toHaveLength(1);
    expect(violations("logger.warn(attachmentText)")).toHaveLength(1);
    expect(violations("console.error(\n  samples.length,\n  audio,\n)")).toHaveLength(1);
  });

  it("allows messages that only mention those words, and harmless expressions", () => {
    expect(violations('console.log("the transcript was kept")')).toEqual([]);
    expect(violations("ports.log(`failed: ${errorMessage(e)}`)")).toEqual([]);
    expect(violations("ports.log(`processing failed: ${kind}`)")).toEqual([]);
    expect(violations("ports.log(`unknown ${redactForLog(payload)}`)")).toEqual([]);
    expect(violations('log("a (nested) call", count)')).toEqual([]);
  });

  it("reads nested parentheses and template literals correctly", () => {
    expect(logCallArguments("x.log(f(a, (b)), `${g(c)}`); y()")).toEqual(["f(a, (b)), `${g(c)}`"]);
  });
});

describe("the source code", () => {
  it("never logs a transcript, prompt, attachment text or audio", () => {
    const bad: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(dir)) {
        for (const args of violations(readFileSync(file, "utf8"))) {
          bad.push(`${relative(ROOT, file)}: log(${args.trim().slice(0, 80)})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("scans a meaningful amount of code", () => {
    const calls = SOURCE_DIRS.flatMap(sourceFiles).flatMap((f) =>
      logCallArguments(readFileSync(f, "utf8")),
    );
    expect(calls.length).toBeGreaterThan(5);
  });
});
