import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTemplates } from "../src/discover.js";
import { loadManifests } from "../src/job-manifest.js";

type Call = {
  server: string;
  tool: string;
  args: Record<string, unknown>;
};

function envelope(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "completed",
          execution: { ok: true, value },
        }),
      },
    ],
  };
}

function accounts(ids: { id: string; label: string }[]) {
  return {
    namespaces: ids.map((item) => ({
      path: "tools.instabox",
      accounts: `instabox: ${item.id} (${item.label})`,
    })),
  };
}

function machines(items: { id: string; name: string; state: string }[]) {
  return envelope({ machines: items });
}

const TEMPLATES = [
  {
    accountId: "${INSTABOX_ACCOUNT_ID}",
    input: { id: "${INSTABOX_MACHINE_ID}" },
  },
];

function script(
  list: { id: string; name: string; state: string }[],
  linked = [{ id: "acc-test", label: "example" }],
) {
  const calls: Call[] = [];
  const call = async (
    _server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    calls.push({ server: _server, tool, args });
    if (tool === "search") return accounts(linked);
    return machines(list);
  };
  return { calls, call };
}

function observed(env: Record<string, string | undefined>) {
  const manifest = loadManifests(env).find(
    (item) => item.tool === "internal.instabox.codeTask",
  );
  return manifest?.observe.args as
    { accountId?: string; input?: { id?: string } } | undefined;
}

test("discovery ignores a suspended machine and uses the only running one", async () => {
  const env: Record<string, string | undefined> = {};
  const { calls, call } = script([
    { id: "m-suspended", name: "suspended-box", state: "suspended" },
    { id: "m-work", name: "work", state: "running" },
  ]);
  const first = await resolveTemplates(env, call, TEMPLATES);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.tool, "search");
  assert.match(String(calls[1]?.args.code ?? ""), /machines\.list/);
  assert.match(String(calls[1]?.args.code ?? ""), /acc-test/);
  const args = observed(env);
  assert.equal(args?.accountId, "acc-test");
  assert.equal(args?.input?.id, "m-work");
  await resolveTemplates(env, call, TEMPLATES);
  assert.equal(calls.length, 2);
});

test("discovery uses the only running machine when the name is absent", async () => {
  const env: Record<string, string | undefined> = {};
  const { call } = script([
    { id: "m-a", name: "alpha", state: "suspended" },
    { id: "m-b", name: "beta", state: "running" },
  ]);
  const result = await resolveTemplates(env, call, TEMPLATES);
  assert.equal(result.ok, true);
  assert.equal(observed(env)?.input?.id, "m-b");
});

test("discovery fails and lists the machines when the choice is ambiguous", async () => {
  const env: Record<string, string | undefined> = {};
  const { calls, call } = script([
    { id: "m-1", name: "alpha", state: "running" },
    { id: "m-2", name: "beta", state: "running" },
  ]);
  const result = await resolveTemplates(env, call, TEMPLATES);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /INSTABOX_MACHINE_ID/);
  assert.match(result.error, /não há exatamente uma máquina em execução/);
  assert.match(result.error, /alpha \(m-1, running\)/);
  assert.match(result.error, /beta \(m-2, running\)/);
  assert.equal(observed(env), undefined);
  assert.equal(calls.filter((item) => item.tool === "execute").length, 1);
});

test("set env vars override discovery", async () => {
  const env = {
    INSTABOX_MACHINE_ID: "m-env",
    INSTABOX_ACCOUNT_ID: "acc-env",
  };
  let calls = 0;
  const result = await resolveTemplates(
    env,
    async () => {
      calls += 1;
      return {};
    },
    TEMPLATES,
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 0);
  const args = observed(env);
  assert.equal(args?.accountId, "acc-env");
  assert.equal(args?.input?.id, "m-env");
});

test("more than one account is an error that lists them", async () => {
  const env: Record<string, string | undefined> = {};
  const { calls, call } = script(
    [],
    [
      { id: "acc-test", label: "example" },
      { id: "acc-other", label: "other" },
    ],
  );
  const result = await resolveTemplates(env, call, TEMPLATES);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /INSTABOX_ACCOUNT_ID/);
  assert.match(result.error, /example \(acc-test\)/);
  assert.match(result.error, /other \(acc-other\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, "search");
});
