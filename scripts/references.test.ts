// Every skill reference in this public repo resolves to a public skill: a skill of this repo, or a plugin on the
// allowlist below. A reference to anything else fails, so a skill of a private plugin cannot be named here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_EXTERNAL_PLUGINS = new Set(["superpowers", "andrej-karpathy-skills", "codex"]);
const TEXT_FILE = /\.(md|json|ts|js|py|sh|ya?ml|txt)$/;
const REFERENCE = /(?<![\w./@-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*):([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w/-])/g;
const PRIVATE_NAME = /[\w-]*private[\w-]*:[a-z]|\bprivate[- ](tools|plugins?|marketplace|skills?)\b|[\w.-]+-private\b/gi;
const THIS_FILE = "scripts/references.test.ts";

function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => TEXT_FILE.test(f) && f !== THIS_FILE);
}

function ownSkills(): Map<string, Set<string>> {
  const skillsByPlugin = new Map<string, Set<string>>();
  for (const plugin of readdirSync(join(ROOT, "plugins"))) {
    const dir = join(ROOT, "plugins", plugin, "skills");
    skillsByPlugin.set(plugin, new Set(existsSync(dir) ? readdirSync(dir) : []));
  }
  return skillsByPlugin;
}

export function findReferences(text: string): { plugin: string; skill: string; line: number }[] {
  const found: { plugin: string; skill: string; line: number }[] = [];
  text.split("\n").forEach((lineText, i) => {
    for (const m of lineText.matchAll(REFERENCE)) {
      found.push({ plugin: m[1], skill: m[2], line: i + 1 });
    }
  });
  return found;
}

export function unresolved(params: { text: string; skillsByPlugin: Map<string, Set<string>> }): string[] {
  const problems: string[] = [];
  for (const ref of findReferences(params.text)) {
    const own = params.skillsByPlugin.get(ref.plugin);
    if (own) {
      if (!own.has(ref.skill)) {
        problems.push(`${ref.line}: ${ref.plugin}:${ref.skill} names no skill of plugin ${ref.plugin}`);
      }
    } else if (ref.plugin.includes("-") && !PUBLIC_EXTERNAL_PLUGINS.has(ref.plugin)) {
      problems.push(`${ref.line}: ${ref.plugin}:${ref.skill} names a plugin that is neither in this repo nor public`);
    }
  }
  return problems;
}

export function privateNames(text: string): string[] {
  const problems: string[] = [];
  text.split("\n").forEach((lineText, i) => {
    for (const m of lineText.matchAll(PRIVATE_NAME)) {
      problems.push(`${i + 1}: ${m[0]}`);
    }
  });
  return problems;
}

test("every plugin:skill reference resolves to a public skill", () => {
  const skillsByPlugin = ownSkills();
  const problems = trackedTextFiles().flatMap((file) =>
    unresolved({ text: readFileSync(join(ROOT, file), "utf8"), skillsByPlugin }).map((p) => `${file}:${p}`),
  );
  assert.deepEqual(problems, []);
});

test("no tracked file names a private plugin, marketplace or skill set", () => {
  const problems = trackedTextFiles().flatMap((file) =>
    privateNames(readFileSync(join(ROOT, file), "utf8")).map((p) => `${file}:${p}`),
  );
  assert.deepEqual(problems, []);
});

test("every marketplace entry is a plugin folder of this repo", () => {
  const claude = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
  const codex = JSON.parse(readFileSync(join(ROOT, ".agents/plugins/marketplace.json"), "utf8"));
  const sources = [
    ...claude.plugins.map((p: { source: unknown }) => p.source),
    ...codex.plugins.map((p: { source: { path?: unknown } }) => p.source.path),
  ];
  for (const source of sources) {
    assert.equal(typeof source, "string", `source ${JSON.stringify(source)} is not a local path`);
    assert.match(source as string, /^\.\/plugins\/[a-z0-9-]+$/);
    assert.ok(existsSync(join(ROOT, source as string)), `${source} does not exist`);
  }
});

test("findReferences and the checks catch what they should and leave prose alone", () => {
  const skillsByPlugin = new Map([["planning", new Set(["refine-plan"])]]);
  assert.deepEqual(unresolved({ text: "Use planning:refine-plan, then superpowers:writing-plans.", skillsByPlugin }), []);
  assert.deepEqual(unresolved({ text: "see file:line and count:length, https://x.io/a:b", skillsByPlugin }), []);
  assert.equal(unresolved({ text: "Use planning:missing-skill", skillsByPlugin }).length, 1);
  assert.equal(unresolved({ text: "then some-tools:ship-feature", skillsByPlugin }).length, 1);
  assert.equal(privateNames("run acme-private-tools:x").length, 1);
  assert.equal(privateNames("the private marketplace").length, 1);
  assert.equal(privateNames("git@github.com:me/skills-private.git").length, 1);
  assert.deepEqual(privateNames('"private": true and private readonly repo'), []);
});
