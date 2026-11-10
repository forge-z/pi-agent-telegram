import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { mcpCallIsReadOnly } from "../src/mcp-calls.js";
import { globMatch, loadHarnessConfig } from "../src/harness-config.js";
import { loadManifests } from "../src/job-manifest.js";
import { PendingJobs } from "../src/pending-jobs.js";
import type { Runtime } from "../src/runtime.js";

async function dir() {
  return mkdtemp(join(tmpdir(), "pi-harness-"));
}

test("defaults reproduce the old read classification", () => {
  assert.equal(mcpCallIsReadOnly("tools.instabox.machines.list"), true);
  assert.equal(mcpCallIsReadOnly("tools.tinyfish.fetch.root.fetchUrls"), true);
  assert.equal(mcpCallIsReadOnly("tools.github.repos.get_or_create"), true);
  assert.equal(
    mcpCallIsReadOnly("listRuns", undefined, { server: "mock" }),
    true,
  );
  assert.equal(mcpCallIsReadOnly("tools.instabox.machines.exec"), false);
  assert.equal(mcpCallIsReadOnly("noSuchTool"), false);
  assert.equal(
    globMatch("tools.*.machines.list", "tools.instabox.machines.list"),
    true,
  );
  assert.equal(
    globMatch("tools.*.machines.list", "tools.tinyfish.fetch.root.fetchUrls"),
    false,
  );
});

test("a user file can mark a read as write and a write as read", async () => {
  const root = await dir();
  const writeFilePath = join(root, "write.yaml");
  const readFilePath = join(root, "read.yaml");
  await writeFile(
    writeFilePath,
    [
      "mcp_servers:",
      "  executor:",
      "    tools:",
      "      write:",
      '        - "tools.instabox.machines.list"',
      "",
    ].join("\n"),
  );
  await writeFile(
    readFilePath,
    [
      "mcp_servers:",
      "  executor:",
      "    tools:",
      "      read:",
      '        - "tools.instabox.machines.exec"',
      "",
    ].join("\n"),
  );
  try {
    const asWrite = loadHarnessConfig({ CONFIG_FILE: writeFilePath });
    assert.equal(
      mcpCallIsReadOnly("tools.instabox.machines.list", undefined, {
        config: asWrite,
      }),
      false,
    );
    assert.equal(
      mcpCallIsReadOnly("tools.tinyfish.fetch.root.fetchUrls", undefined, {
        config: asWrite,
      }),
      true,
    );
    const asRead = loadHarnessConfig({ CONFIG_FILE: readFilePath });
    assert.equal(
      mcpCallIsReadOnly("tools.instabox.machines.exec", undefined, {
        config: asRead,
      }),
      true,
    );
    assert.equal(
      mcpCallIsReadOnly("search", undefined, { config: asRead }),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted readOnlyHint is a read; untrusted hint and unknown tools are writes", async () => {
  const root = await dir();
  const trusted = join(root, "trusted.yaml");
  const untrusted = join(root, "untrusted.yaml");
  await writeFile(
    trusted,
    ["mcp_servers:", "  notes:", "    trust: trusted", ""].join("\n"),
  );
  await writeFile(
    untrusted,
    ["mcp_servers:", "  notes:", "    trust: untrusted", ""].join("\n"),
  );
  try {
    const trustedConfig = loadHarnessConfig({ CONFIG_FILE: trusted });
    const untrustedConfig = loadHarnessConfig({ CONFIG_FILE: untrusted });
    assert.equal(
      mcpCallIsReadOnly("lookup", undefined, {
        server: "notes",
        readOnlyHint: true,
        config: trustedConfig,
      }),
      true,
    );
    assert.equal(
      mcpCallIsReadOnly("lookup", undefined, {
        server: "notes",
        readOnlyHint: true,
        config: untrustedConfig,
      }),
      false,
    );
    assert.equal(
      mcpCallIsReadOnly("lookup", undefined, {
        server: "notes",
        config: trustedConfig,
      }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid yaml is logged and the defaults stay", async () => {
  const root = await dir();
  const path = join(root, "broken.yaml");
  await writeFile(path, "mcp_servers: [\n");
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    original(...args);
  };
  try {
    const config = loadHarnessConfig({ CONFIG_FILE: path });
    assert.match(lines.join("\n"), /inválido/);
    assert.match(lines.join("\n"), /config\.default\.yaml/);
    assert.equal(
      mcpCallIsReadOnly("tools.instabox.machines.list", undefined, { config }),
      true,
    );
    assert.equal(
      mcpCallIsReadOnly("tools.tinyfish.fetch.root.fetchUrls", undefined, {
        config,
      }),
      true,
    );
  } finally {
    console.error = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped jobs stay, and ASYNC_JOB_MANIFESTS replaces the same tool", () => {
  const plain = loadManifests({});
  const tiny = plain.find(
    (item) => item.tool === "tools.tinyfish.agent.automation.runAsync",
  );
  assert.equal(tiny?.server, "executor");
  assert.equal(tiny?.observe.tool, "tools.tinyfish.agent.runs.getRunById");
  assert.deepEqual(tiny?.observe.args, {
    accountId: "${accountId}",
    input: { path: { id: "${job_id}" } },
  });
  assert.equal(
    plain.some((item) => item.tool === "internal.instabox.codeTask"),
    false,
  );
  const instabox = loadManifests({
    INSTABOX_MACHINE_ID: "machine-123",
    INSTABOX_ACCOUNT_ID: "acc-test",
  }).find((item) => item.tool === "internal.instabox.codeTask");
  assert.equal(instabox?.observe.tool, "tools.instabox.machines.readFiles");
  assert.deepEqual(instabox?.observe.args, {
    accountId: "acc-test",
    input: {
      id: "machine-123",
      path: "/data/home/jobs/${id}/status.json",
    },
  });
  const replaced = loadManifests({
    ASYNC_JOB_MANIFESTS: JSON.stringify([
      {
        tool: "tools.tinyfish.agent.automation.runAsync",
        server: "freestyle",
        observe: { mode: "poll", tool: "getJob" },
      },
    ]),
  }).filter((item) => item.tool === "tools.tinyfish.agent.automation.runAsync");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.server, "freestyle");
  assert.equal(replaced[0]?.observe.tool, "getJob");
});

test("a freestyle manifest polls its own server and tool", async () => {
  const root = await dir();
  const configPath = join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "async_jobs:",
      "  freestyle:",
      "    tool: freestyle.jobs.start",
      "    server: freestyle",
      "    dispatch:",
      "      mode: immediate",
      "      idPath: id",
      "    observe:",
      "      mode: poll",
      "      tool: getJob",
      "      args:",
      '        id: "${id}"',
      "      statePath: state",
      "      resultPath: result",
      "",
    ].join("\n"),
  );
  const store = new Store(root);
  const calls: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
  }[] = [];
  const submissions: string[] = [];
  const app = {
    store,
    options: {
      gateway: {
        callDirect: async (
          server: string,
          tool: string,
          args: Record<string, unknown>,
        ) => {
          calls.push({ server, tool, args });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: "job-1",
                  state: "DONE",
                  result: { ok: true },
                }),
              },
            ],
          };
        },
      },
    },
    submit: async (
      _conversationId: string,
      _requestId: string,
      text: string,
    ) => {
      submissions.push(text);
      return {};
    },
  };
  const jobs = new PendingJobs(app as unknown as Runtime, {
    CONFIG_FILE: configPath,
    DATA_DIR: root,
  });
  try {
    assert.equal(
      jobs.registerKnown("chat", "freestyle.jobs.start", "job-1", "gerar"),
      true,
    );
    await jobs.tick();
    assert.deepEqual(calls, [
      { server: "freestyle", tool: "getJob", args: { id: "job-1" } },
    ]);
    assert.equal(submissions.length, 1);
    assert.match(submissions[0] ?? "", /"ok":true/);
  } finally {
    jobs.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
