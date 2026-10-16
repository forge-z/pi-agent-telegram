import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readAppInfo, resolveBuildCommit } from "../dist/src/app-info.js";

// This runs only after compilation, never at application startup.
const root = pathToFileURL(process.cwd() + "/");
const rawCommit = resolveBuildCommit();
const info = readAppInfo(root, false);
await writeFile(
  new URL("dist/build-info.json", root),
  JSON.stringify({
    ...info,
    ...(rawCommit ? { commit: rawCommit.trim().toLowerCase() } : {}),
    builtAt: new Date().toISOString(),
  }) + "\n",
);
