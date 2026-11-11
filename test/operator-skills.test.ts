import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getSystemMessageText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadHarnessConfig } from "../src/harness-config.js";
import { loadOperatorSkills } from "../src/operator-skills.js";
import { Runtime } from "../src/runtime.js";

const gateway = { catalog: async () => [] };

function systemText(messages: readonly Message[]) {
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string" && message.content)
      content.push(message.content);
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(key);
      else sections.set(key, value);
    }
  }
  return getSystemMessageText({
    role: "system",
    content: content.join("\n\n"),
    sections: Object.fromEntries(sections),
    timestamp: 0,
  });
}

async function promptFor(
  root: string,
  submit: (app: Runtime, id: string) => Promise<void> = async (app, id) => {
    await app.submit(id, "turn-1", "hello");
    await (await app.conversation(id)).waitForIdle(context);
    await new Promise((resolve) => setTimeout(resolve, 20));
  },
  responses = 1,
) {
  const prompts: string[] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from(
      { length: responses },
      () => async (ctx: { messages: Message[] }) => {
        prompts.push(systemText(ctx.messages));
        return fauxAssistantMessage("ok");
      },
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir: root,
    gateway,
    models,
    env: { DATA_DIR: root, TZ: "UTC" },
    now: () => Date.parse("2026-11-11T12:00:00Z"),
  });
  try {
    const id = await app.create();
    await submit(app, id);
    return prompts;
  } finally {
    await app.close();
  }
}

async function skillFile(
  root: string,
  name: string,
  body: string,
  front?: string,
) {
  const dir = join(root, "skills", name);
  await mkdir(dir, { recursive: true });
  const matter =
    front ?? `---\nname: ${name}\ndescription: Notes for ${name}.\n---\n\n`;
  await writeFile(join(dir, "SKILL.md"), `${matter}${body}\n`);
}

function env(root: string) {
  return { DATA_DIR: root, TZ: "UTC" };
}

function errorsOf(run: () => void) {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
    return lines;
  } finally {
    console.error = original;
  }
}

test("no skills folder leaves the system prompt unchanged", async () => {
  const plain = await mkdtemp(join(tmpdir(), "pi-skills-plain-"));
  const listed = await mkdtemp(join(tmpdir(), "pi-skills-listed-"));
  const missing = await mkdtemp(join(tmpdir(), "pi-skills-missing-"));
  try {
    await skillFile(listed, "weekly-review", "UNIQUE WEEKLY BODY");
    await writeFile(join(listed, "config.yaml"), "skills:\n  always: []\n");
    await writeFile(
      join(missing, "config.yaml"),
      "skills:\n  always:\n    - weekly-review\n",
    );
    const [base, unused, skipped] = await Promise.all([
      promptFor(plain),
      promptFor(listed),
      promptFor(missing),
    ]);
    assert.equal(base.length, 1);
    assert.equal(unused[0], base[0]);
    assert.equal(skipped[0], base[0]);
    assert.equal(base[0]?.includes("UNIQUE WEEKLY BODY"), false);
    assert.equal(base[0]?.includes("operator-skills"), false);
    const logged = errorsOf(() => loadOperatorSkills(env(missing)));
    assert.match(
      logged.join("\n"),
      /skill weekly-review ignorada \(não encontrada\)/,
    );
    assert.equal(loadOperatorSkills(env(plain)), "");
    assert.equal(loadOperatorSkills(env(listed)), "");
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(listed, { recursive: true, force: true });
    await rm(missing, { recursive: true, force: true });
  }
});

test("a listed skill is appended after the base instructions and stays on a scheduled turn", async () => {
  const plain = await mkdtemp(join(tmpdir(), "pi-skills-base-"));
  const root = await mkdtemp(join(tmpdir(), "pi-skills-on-"));
  const body = "List what is still open from the week and what can wait.";
  try {
    await skillFile(root, "weekly-review", body);
    await writeFile(
      join(root, "config.yaml"),
      "skills:\n  always:\n    - weekly-review\n",
    );
    const baseline = (await promptFor(plain))[0];
    const prompts = await promptFor(
      root,
      async (app, id) => {
        await app.submit(id, "turn-1", "hello");
        await (await app.conversation(id)).waitForIdle(context);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await app.submit(id, "task:1", "run the weekly review", "task");
        await (await app.conversation(id)).waitForIdle(context);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      2,
    );
    assert.equal(prompts.length, 2);
    const prompt = prompts[0]!;
    assert.equal(prompt, `${baseline}\n\n${body}`);
    assert.equal(prompts[1], prompt);
    const scheduling = prompt.indexOf("Use tasks_list and tasks_create");
    const policy = prompt.indexOf("You are a personal assistant");
    const longTask = prompt.indexOf("call sandbox_code_task once");
    const skill = prompt.lastIndexOf(body);
    assert.ok(scheduling >= 0 && scheduling < policy);
    assert.ok(policy < longTask);
    assert.ok(longTask < skill);
    assert.equal(skill, prompt.length - body.length);
    assert.equal(loadOperatorSkills(env(root)), body);
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing, invalid, or unreadable skill is skipped and the bot still boots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-skip-"));
  const outside = "OUTSIDE SKILL BODY";
  const body = "Keep the valid weekly note.";
  try {
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(
      join(root, "outside", "SKILL.md"),
      `---\nname: outside\ndescription: hidden\n---\n\n${outside}\n`,
    );
    await mkdir(join(root, "skills", "broken", "SKILL.md"), {
      recursive: true,
    });
    await skillFile(
      root,
      "bad-yaml",
      "BAD YAML BODY",
      "---\nname: [broken\n---\n\n",
    );
    await skillFile(
      root,
      "wrong-name",
      "WRONG NAME BODY",
      "---\nname: other\ndescription: mismatch\n---\n\n",
    );
    await skillFile(
      root,
      "empty-body",
      "",
      "---\nname: empty-body\ndescription: blank\n---\n\n",
    );
    await skillFile(root, "weekly-review", body);
    await writeFile(
      join(root, "config.yaml"),
      [
        "skills:",
        "  always:",
        "    - weekly-review",
        "    - missing-skill",
        "    - ../outside",
        "    - broken",
        "    - bad-yaml",
        "    - wrong-name",
        "    - empty-body",
        "",
      ].join("\n"),
    );
    const logged = errorsOf(() => {
      assert.equal(loadOperatorSkills(env(root)), body);
      assert.equal(loadOperatorSkills(env(root)), body);
    });
    const text = logged.join("\n");
    assert.match(text, /missing-skill ignorada \(não encontrada\)/);
    assert.match(text, /\.\.\/outside ignorada \(nome inválido\)/);
    assert.match(text, /broken ignorada \(ilegível\)/);
    assert.match(text, /bad-yaml ignorada \(frontmatter inválido\)/);
    assert.match(
      text,
      /wrong-name ignorada \(name ausente ou diferente da pasta\)/,
    );
    assert.match(text, /empty-body ignorada \(corpo vazio\)/);
    assert.equal(text.includes(outside), false);
    assert.equal(text.includes("BAD YAML"), false);
    const prompts = await promptFor(root);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.endsWith(body), true);
    assert.equal(prompts[0]?.includes(outside), false);
    assert.equal(prompts[0]?.includes("BAD YAML BODY"), false);
    assert.equal(prompts[0]?.includes("WRONG NAME BODY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill text is deterministic and follows skills.always order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-order-"));
  try {
    await skillFile(root, "alpha-note", "ALPHA BODY");
    await skillFile(root, "zeta-note", "ZETA BODY");
    await writeFile(
      join(root, "config.yaml"),
      "skills:\n  always:\n    - zeta-note\n    - alpha-note\n",
    );
    const once = loadOperatorSkills(env(root));
    const twice = loadOperatorSkills(env(root));
    assert.equal(once, "ZETA BODY\n\nALPHA BODY");
    assert.equal(twice, once);
    const prompts = await promptFor(root);
    assert.equal(prompts[0]?.endsWith(once), true);
    assert.equal(prompts[0]?.includes("ALPHA BODY\n\nZETA BODY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills.always must be a list of names and replaces the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-schema-"));
  const bad = join(root, "bad.yaml");
  const good = join(root, "good.yaml");
  await writeFile(bad, "skills:\n  always: weekly-review\n");
  await writeFile(good, "skills:\n  always:\n    - weekly-review\n");
  try {
    const logged = errorsOf(() => {
      const config = loadHarnessConfig({ CONFIG_FILE: bad, DATA_DIR: root });
      assert.deepEqual(config.skillsAlways, []);
    });
    assert.match(
      logged.join("\n"),
      /skills\.always precisa ser uma lista de textos/,
    );
    assert.deepEqual(loadHarnessConfig({ DATA_DIR: root }).skillsAlways, []);
    assert.deepEqual(loadHarnessConfig({ CONFIG_FILE: good }).skillsAlways, [
      "weekly-review",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
