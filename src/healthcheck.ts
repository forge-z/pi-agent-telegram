import { readFileSync } from "node:fs";
try {
  const { at } = JSON.parse(
    readFileSync(`${process.env.DATA_DIR ?? "data"}/health.json`, "utf8"),
  );
  process.exit(typeof at === "number" && Date.now() - at < 90_000 ? 0 : 1);
} catch {
  process.exit(1);
}
