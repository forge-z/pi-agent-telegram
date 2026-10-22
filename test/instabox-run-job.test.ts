import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const START = join(process.cwd(), "scripts/instabox/start-job.sh");
const RUN = join(process.cwd(), "scripts/instabox/run-job.sh");

const GH = `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  mkdir -p "$4/.git"
fi
exit 0
`;

const GIT = `#!/bin/sh
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  rev-parse) printf '%s\\n' abc123 ;;
esac
exit 0
`;

const AGENT = `#!/bin/sh
ps -o sid= -p $$ | tr -d ' ' > "$HOME/agent-sid.txt"
printf '%s\\n' "$*" > "$HOME/agent-args.txt"
sleep 1.2
exit 0
`;

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "instabox-job-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "gh"), GH, { mode: 0o755 });
  await writeFile(join(bin, "git"), GIT, { mode: 0o755 });
  for (const name of ["agy", "pi", "claude"])
    await writeFile(join(bin, name), AGENT, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  return {
    root,
    home,
    env,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [file, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function readStatus(home: string, jobId: string) {
  const raw = await readFile(join(home, "jobs", jobId, "status.json"), "utf8");
  return JSON.parse(raw) as {
    state: string;
    error?: string;
    result?: { pr?: string; branch?: string; summary?: string };
  };
}

async function waitStatus(
  home: string,
  jobId: string,
  ready: (state: string) => boolean,
) {
  const file = join(home, "jobs", jobId, "status.json");
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 8000) {
    try {
      last = await readFile(file, "utf8");
      const parsed = JSON.parse(last) as { state?: string };
      if (parsed.state && ready(parsed.state)) return parsed;
    } catch {
      /* status is replaced atomically; a missing or partial read retries */
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `status de ${jobId} não chegou a tempo: ${last || "<ausente>"}`,
  );
}

test("run-job.sh grava RUNNING e DONE com os argumentos do node -e", async () => {
  const box = await sandbox();
  const jobId = "cj-argvfix1";
  const prompt = 'corrija o argv do node -e, "sem" perder o prompt';
  try {
    const jobDir = join(box.home, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "request.json"),
      JSON.stringify({
        repo: "forge-z/example",
        agent: "agy",
        prompt,
        branch: "agent/cj-argvfix1",
      }),
    );
    const result = await run(RUN, [jobId], box.env);
    assert.equal(
      result.code,
      0,
      `run-job falhou\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.branch, "agent/cj-argvfix1");
    assert.match(
      status.result?.summary ?? "",
      /stub|Tarefa concluída|sleep|agy/i,
    );
    const args = await readFile(join(box.home, "agent-args.txt"), "utf8");
    assert.match(args, /corrija o argv/);
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|newPath/);
  } finally {
    await box.close();
  }
});

test("fail() grava FAILED no status.json e não perde o caminho no argv", async () => {
  const box = await sandbox();
  const jobId = "cj-failpath";
  try {
    await mkdir(join(box.home, "jobs", jobId), { recursive: true });
    const result = await run(RUN, [jobId], box.env);
    assert.notEqual(result.code, 0);
    const status = await readStatus(box.home, jobId);
    assert.equal(status.state, "FAILED");
    assert.match(status.error ?? "", /request\.json não encontrado/);
    assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|newPath/);
  } finally {
    await box.close();
  }
});

test("start-job.sh solta o runner numa sessão nova que sobrevive ao fim do exec", async () => {
  const box = await sandbox();
  const jobId = "cj-detach1";
  const prompt = "continue depois que a sessão do exec acabar";
  try {
    const child = spawn("bash", [START, jobId], {
      env: box.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(
      JSON.stringify({
        repo: "forge-z/example",
        agent: "agy",
        prompt,
        branch: "agent/cj-detach1",
      }),
    );
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => resolve(status ?? 1));
    });
    assert.equal(code, 0, `start-job falhou\n${stderr}\n${stdout}`);
    assert.match(stdout, /PENDING/);

    await waitStatus(box.home, jobId, (state) => state === "RUNNING");
    const sidFile = join(box.home, "agent-sid.txt");
    let runnerSid = "";
    const sidWait = Date.now();
    while (Date.now() - sidWait < 4000) {
      try {
        runnerSid = (await readFile(sidFile, "utf8")).trim();
        if (runnerSid) break;
      } catch {
        /* the agent writes its session id as it starts */
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(runnerSid, "o agente não chegou a gravar a sessão");
    assert.notEqual(
      runnerSid,
      String(child.pid),
      "o runner continua na sessão do launcher",
    );
    for (const signal of ["SIGTERM", "SIGHUP"] as const) {
      try {
        process.kill(-child.pid!, signal);
      } catch (error) {
        const missing =
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ESRCH";
        if (!missing) throw error;
      }
    }
    const status = await waitStatus(
      box.home,
      jobId,
      (state) => state === "DONE",
    );
    assert.equal(status.state, "DONE");
    const args = await readFile(join(box.home, "agent-args.txt"), "utf8");
    assert.match(args, /sessão do exec/);
  } finally {
    await box.close();
  }
});

function execNode(code: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("node", ["-e", code, ...args], (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error)));
      else resolve();
    });
  });
}

test("os trechos node -e do run-job aceitam o primeiro argumento como caminho", async () => {
  const source = await readFile(RUN, "utf8");
  const snippets = [...source.matchAll(/node -e '([\s\S]*?)'/g)].map(
    (match) => match[1] ?? "",
  );
  const writers = snippets.filter((code) => code.includes("const ["));
  assert.equal(writers.length, 3, "FAILED, RUNNING e DONE gravam status");
  for (const code of writers) {
    assert.match(code, /const \[, /);
    assert.doesNotMatch(code, /const \[,, /);
  }
  for (const code of snippets) {
    if (code.includes("process.stdout.write"))
      assert.match(code, /process\.argv\[1\]/);
  }
  const dir = await mkdtemp(join(tmpdir(), "instabox-snippet-"));
  try {
    const statusPath = join(dir, "status.json");
    const logPath = join(dir, "agent.log");
    await writeFile(logPath, "resumo do agente\n");
    const failed = writers.find((code) => code.includes('"FAILED"'));
    const running = writers.find((code) => code.includes('"RUNNING"'));
    const done = writers.find((code) => code.includes('"DONE"'));
    assert.ok(failed && running && done);
    await execNode(running, [statusPath]);
    assert.equal(
      JSON.parse(await readFile(statusPath, "utf8")).state,
      "RUNNING",
    );
    await execNode(failed, [statusPath, "request.json não encontrado"]);
    const failure = JSON.parse(await readFile(statusPath, "utf8")) as {
      state: string;
      error?: string;
    };
    assert.equal(failure.state, "FAILED");
    assert.match(failure.error ?? "", /request\.json não encontrado/);
    await execNode(done, [
      statusPath,
      logPath,
      "https://example.com/pull/9",
      "agent/cj-snippet",
    ]);
    const status = JSON.parse(await readFile(statusPath, "utf8")) as {
      state: string;
      result?: { pr?: string; branch?: string; summary?: string };
    };
    assert.equal(status.state, "DONE");
    assert.equal(status.result?.pr, "https://example.com/pull/9");
    assert.equal(status.result?.branch, "agent/cj-snippet");
    assert.match(status.result?.summary ?? "", /resumo do agente/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
