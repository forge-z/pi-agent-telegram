import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  assertDurablePurgeSafe,
  TrashBlockedError,
} from "../src/conversation-trash.js";

const IDLE_CONVERSATION = 5;
const SLEEPING_CONVERSATION = 4;

async function migrated() {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-schema-"));
  const database = await openNodeSqliteDatabase(join(dir, "durable.sqlite"));
  const storage = await SqliteStorage.open(database);
  return {
    database,
    async close() {
      await storage.close(context);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Pi 1.4 migrates durable SQLite to schema 2 and purge accepts a sleeping task", async () => {
  const fixture = await migrated();
  try {
    const schema = await fixture.database.get<{ version: number }>(
      "SELECT version FROM durable_schema WHERE singleton=1",
    );
    assert.equal(schema?.version, 2);
    assert.equal(schema?.version, CURRENT_SQLITE_SCHEMA_VERSION);
    await assertDurablePurgeSafe(fixture.database, IDLE_CONVERSATION);

    const record = {
      id: 2,
      conversationId: SLEEPING_CONVERSATION,
      kind: "pi.generation",
      version: 1,
      background: false,
      abortRequested: false,
      state: { status: "sleeping", checkpoint: {}, until: 1_700_000_000_000 },
    };
    await fixture.database.run(
      "INSERT INTO record_ids (id, record_type) VALUES (2, 'task')",
    );
    await fixture.database.run(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES (2, ?, json_quote(?), 'sleeping', 0, 0, ?)`,
      SLEEPING_CONVERSATION,
      record.kind,
      JSON.stringify(record),
    );
    await assertDurablePurgeSafe(fixture.database, IDLE_CONVERSATION);
    await assert.rejects(
      () => assertDurablePurgeSafe(fixture.database, SLEEPING_CONVERSATION),
      (error: unknown) => {
        assert.ok(error instanceof TrashBlockedError);
        assert.match(error.message, /execução pendente/);
        return true;
      },
    );

    await fixture.database.run(
      "UPDATE durable_schema SET version=3 WHERE singleton=1",
    );
    await assert.rejects(
      () => assertDurablePurgeSafe(fixture.database, IDLE_CONVERSATION),
      (error: unknown) => {
        assert.ok(error instanceof TrashBlockedError);
        assert.match(error.message, /incompatível/);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});
