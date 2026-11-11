import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadHarnessConfig } from "./harness-config.js";

/**
 * Operator skills on the data volume: `$DATA_DIR/skills/<name>/SKILL.md`.
 * `skills.always` lists the folder names. Each markdown body is read once
 * here, at startup, and appended to the stable system prompt. A missing
 * name, invalid frontmatter, or unreadable file is logged and skipped.
 */

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function dataDir(env: Env) {
  return env.DATA_DIR?.trim() || "data";
}

/** One path segment. `..` and separators would escape `$DATA_DIR/skills`. */
function folderName(name: string) {
  return (
    name.length > 0 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

function skip(name: string, reason: string) {
  const label = name.replace(/\s+/g, " ").slice(0, 80);
  console.error(`Pi-Agent: skill ${label} ignorada (${reason}).`);
}

function bodyOf(text: string, folder: string): string | undefined {
  const source = text.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) {
    skip(folder, "frontmatter inválido");
    return;
  }
  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch {
    skip(folder, "frontmatter inválido");
    return;
  }
  if (!isRecord(parsed)) {
    skip(folder, "frontmatter inválido");
    return;
  }
  if (typeof parsed.name !== "string" || parsed.name !== folder) {
    skip(folder, "name ausente ou diferente da pasta");
    return;
  }
  if (typeof parsed.description !== "string" || !parsed.description.trim()) {
    skip(folder, "frontmatter inválido");
    return;
  }
  const body = match[2].trim();
  if (!body) {
    skip(folder, "corpo vazio");
    return;
  }
  return body;
}

function readSkill(dir: string, name: string) {
  if (!folderName(name)) {
    skip(name, "nome inválido");
    return;
  }
  let text: string;
  try {
    text = readFileSync(join(dir, name, "SKILL.md"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    skip(name, code === "ENOENT" ? "não encontrada" : "ilegível");
    return;
  }
  return bodyOf(text, name);
}

/** Bodies for `skills.always`, in list order. Empty when nothing applies. */
export function loadOperatorSkills(env: Env = process.env) {
  try {
    const names = loadHarnessConfig(env).skillsAlways;
    const dir = join(dataDir(env), "skills");
    const parts: string[] = [];
    for (const name of names) {
      const body = readSkill(dir, name);
      if (body) parts.push(body);
    }
    return parts.join("\n\n");
  } catch (error) {
    console.error(
      `Pi-Agent: skills ignoradas (${error instanceof Error ? error.name : "erro"}).`,
    );
    return "";
  }
}
