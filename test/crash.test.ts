import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../src/runtime.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Telegram } from "../src/telegram.js";

test(
  "SIGKILL mid-model, external effect and Telegram send resumes input without replaying uncertain effects",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-crash-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/crash-child.ts", dir],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let app: Runtime | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let errors = "";
        const timeout = setTimeout(
          () => reject(new Error(`Child timed out ${output} ${errors}`)),
          5000,
        );
        child.stderr.on("data", (chunk) => {
          errors += chunk.toString();
        });
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          if (
            ["MODEL_PENDING", "ACTION_PENDING", "DELIVERY_PENDING"].every((s) =>
              output.includes(s),
            )
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout);
            reject(new Error(`Child exited ${code}: ${errors}`));
          }
        });
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      // A stale owner lease must expire before a new owner opens the same SQLite volume.
      await new Promise((resolve) => setTimeout(resolve, 31000));
      let external = 0,
        sends = 0;
      app = await Runtime.open({
        dir,
        gateway: {
          call: async () => {
            external++;
            return {};
          },
        },
      });
      const id = app.store.get<{ id: string }>(
        "SELECT id FROM conversations",
      )!.id;
      await (await app.conversation(id)).waitForIdle(context);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(app.store.actions(id)[0].state, "uncertain");
      assert.equal(external, 0);
      const telegram = new Telegram(
        app,
        {
          send: async () => {
            sends++;
            return {};
          },
        },
        ["42"],
        ["100"],
      );
      await telegram.flush();
      assert.equal(sends, 0);
      assert.equal(
        app.store.get<{ state: string }>(
          "SELECT state FROM deliveries WHERE id='crash-delivery'",
        )?.state,
        "uncertain",
      );
      assert.equal(
        await readFile(`${dir}/effects.log`, "utf8"),
        "write\nsend\n",
      );
      const snapshot = await app.snapshot(id);
      assert.equal(
        snapshot.view.entries.filter((e) => e.kind === "pi.user").length,
        2,
      );
      assert.ok(
        snapshot.view.entries.some(
          (e) =>
            e.kind === "pi.assistant" &&
            e.model?.some(
              (m) =>
                m.role === "assistant" &&
                m.content.some(
                  (c) => c.type === "text" && c.text.includes("resume me"),
                ),
            ),
        ),
      );
      const resumed = await app.submit(id, "crash-request", "resume me");
      assert.equal(
        Number(resumed.submissionId),
        app.store.get<{ submissionId: number }>(
          "SELECT submissionId FROM requests WHERE requestId='crash-request'",
        )?.submissionId,
      );
    } finally {
      child.kill("SIGKILL");
      if (app) await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
