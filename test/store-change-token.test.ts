import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

test("change token moves with every commit, including other connections, and is withheld inside transactions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-change-token-"));
  const store = new Store(dir);
  const other = new DatabaseSync(join(dir, "app.sqlite"));
  try {
    const initial = store.changeToken();
    assert.ok(initial);
    store.get("SELECT * FROM conversations");
    assert.equal(store.changeToken(), initial);

    store.run("INSERT INTO conversations VALUES ('1','Own write')");
    const afterOwn = store.changeToken();
    assert.notEqual(afterOwn, initial);

    other.prepare("INSERT INTO conversations VALUES ('2','Other write')").run();
    assert.notEqual(store.changeToken(), afterOwn);

    store.db.exec("BEGIN");
    store.run("UPDATE conversations SET title='Uncommitted' WHERE id='1'");
    assert.equal(store.changeToken(), undefined);
    store.db.exec("ROLLBACK");
    assert.ok(store.changeToken());
  } finally {
    other.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
