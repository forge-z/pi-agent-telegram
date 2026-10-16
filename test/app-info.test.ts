import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAppInfo } from "../src/app-info.js";

const commit = "260db40072e098add8e6b861b3fa5346732ed2c7";
const builtAt = "2026-10-13T12:34:56.000Z";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-app-info-"));
  const root = pathToFileURL(dir + "/");
  await mkdir(join(dir, "dist"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ version: "0.1.0", secret: "package-secret" }),
  );
  const manifest = (value: unknown) =>
    writeFile(join(dir, "dist/build-info.json"), JSON.stringify(value));
  return {
    root,
    dir,
    manifest,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test("installed build identity takes precedence over runtime environment and drops extra fields", async () => {
  const f = await fixture();
  try {
    await f.manifest({
      commit,
      builtAt,
      version: "99.0.0",
      WEB_PASSWORD: "manifest-secret",
    });
    assert.deepEqual(readAppInfo(f.root, false, "a".repeat(40)), {
      version: "0.1.0",
      commit: "260db40",
      builtAt,
    });
    assert.equal(readAppInfo(f.root, true, commit).builtAt, null);
  } finally {
    await f.close();
  }
});

test("missing metadata uses only a valid SOURCE_COMMIT and never invents a build date", async () => {
  const f = await fixture();
  try {
    await f.manifest({});
    assert.deepEqual(readAppInfo(f.root, false, commit), {
      version: "0.1.0",
      commit: "260db40",
      builtAt: null,
    });
    for (const source of [
      undefined,
      "",
      "unknown",
      "secret-value",
      "$(cat /secrets)",
    ]) {
      assert.deepEqual(readAppInfo(f.root, false, source), {
        version: "0.1.0",
        commit: null,
        builtAt: null,
      });
    }
    assert.deepEqual(readAppInfo(f.root, false, "260db40"), {
      version: "0.1.0",
      commit: "260db40",
      builtAt: null,
    });
  } finally {
    await f.close();
  }
});

test("malformed or absent package and build metadata remain unknown without crashing", async () => {
  const f = await fixture();
  try {
    await f.manifest({
      commit: "secret-value",
      builtAt: "2026-02-30T12:34:56.000Z",
    });
    assert.deepEqual(readAppInfo(f.root, false, undefined), {
      version: "0.1.0",
      commit: null,
      builtAt: null,
    });
    await writeFile(
      join(f.dir, "dist/build-info.json"),
      "invalid json with a secret",
    );
    await writeFile(join(f.dir, "package.json"), "invalid json");
    assert.deepEqual(readAppInfo(f.root, false, undefined), {
      version: null,
      commit: null,
      builtAt: null,
    });
    await rm(join(f.dir, "package.json"));
    assert.equal(readAppInfo(f.root, false, undefined).version, null);
  } finally {
    await f.close();
  }
});
