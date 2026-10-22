import { utimesSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import { configureTelegram } from "../src/telegram-polling.js";

const dir = process.argv[2];
const submit = process.argv[3] === "submit";
const faux = fauxProvider();
faux.setResponses([
  async () => {
    await new Promise(() => {});
    return fauxAssistantMessage("nunca");
  },
]);
const models = createModels();
models.setProvider(faux.provider);
const app = await Runtime.open({
  dir,
  models,
  gateway: { call: async () => ({}) },
  telegramOnly: true,
  initialize: (store) =>
    configureTelegram(
      store,
      { token: "123:synthetic-only", users: ["42"], chats: ["-100123"] },
      { id: 123, username: "test_bot" },
    ),
});
if (submit) {
  const id = await app.telegramChats.ensure({
    chat: "-100123",
    user: "42",
    messageThreadId: 11,
  });
  await app.submit(
    id,
    "park-turn",
    "responda quando puder",
    "telegram",
    "-100123",
  );
}
const deadline = Date.now() + 10_000;
let running = false;
while (Date.now() < deadline) {
  const inspection = await app.harness.inspect(context);
  running = inspection.tasks.some(
    (task) =>
      task.record.kind === "pi.generation" &&
      task.record.state.status === "running",
  );
  if (running) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!running) {
  console.error("pi.generation nunca ficou running");
  process.exit(1);
}
// Leave the task running. A graceful close would write it back as pending and
// would not count. Aging the lock lets the next process open at once.
const stale = new Date(Date.now() - 60_000);
utimesSync(`${dir}/owner.lock`, stale, stale);
process.exit(0);
