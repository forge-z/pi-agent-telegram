import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

test("savepoints commit or roll back atomically, alone or inside an outer transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-store-savepoint-"));
  const store = new Store(dir);
  const titles = () =>
    store
      .all<{ title: string }>("SELECT title FROM conversations ORDER BY id")
      .map((row) => row.title);
  try {
    assert.equal(
      store.savepoint("alone", () => {
        store.run("INSERT INTO conversations VALUES ('1','kept')");
        return "result";
      }),
      "result",
    );
    assert.throws(
      () =>
        store.savepoint("alone", () => {
          store.run("INSERT INTO conversations VALUES ('2','discarded')");
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(store.db.isTransaction, false);
    store.db.exec("BEGIN IMMEDIATE");
    store.run("INSERT INTO conversations VALUES ('3','outer')");
    assert.throws(() =>
      store.savepoint("nested", () => {
        store.run("INSERT INTO conversations VALUES ('4','inner')");
        throw new Error("inner failure");
      }),
    );
    assert.equal(store.db.isTransaction, true);
    store.db.exec("COMMIT");
    assert.deepEqual(titles(), ["kept", "outer"]);
    assert.throws(
      () =>
        store.savepoint("async_work", (async () => {
          store.run("INSERT INTO conversations VALUES ('5','async')");
        }) as () => unknown),
      /assíncrona/,
    );
    assert.throws(
      () => store.savepoint("x; DROP TABLE x", () => 1),
      /inválido/,
    );
    assert.deepEqual(titles(), ["kept", "outer"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
