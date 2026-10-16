import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import type { Task } from "../src/tasks.js";

test(
  "SIGKILL after schedule commit resumes the tool with the original receipt, without a duplicate or expired-date error",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-task-tool-crash-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/task-tool-crash-child.ts", dir],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let app: Runtime | undefined;
    try {
      const task = await new Promise<Task>((resolve, reject) => {
        let output = "",
          errors = "";
        const timeout = setTimeout(
          () => reject(new Error(`Child timed out: ${errors}`)),
          5000,
        );
        child.stderr.on("data", (chunk) => {
          errors += String(chunk);
        });
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          const match = /TASK_COMMITTED (.+)\n/.exec(output);
          if (match) {
            clearTimeout(timeout);
            resolve(JSON.parse(match[1]) as Task);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Child exited ${code}: ${errors}`));
        });
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 31000));
      app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
      await (await app.conversation(task.conversationId)).waitForIdle(context);
      assert.deepEqual(app.tasks.list(), [task]);
      assert.equal(app.store.all("SELECT * FROM task_creations").length, 1);
      const snapshot = await app.snapshot(task.conversationId);
      const results = snapshot.view.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, false);
      assert.ok(JSON.stringify(results).includes(task.id));
      assert.ok(
        task.nextRun! < Date.now(),
        "the once time expired before the safe tool replay",
      );
    } finally {
      child.kill("SIGKILL");
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
