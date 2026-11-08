import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";

const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage(
    {
      type: "toolCall",
      id: "schedule-once",
      name: "tasks_create",
      arguments: {
        title: "Crash recovery fixture",
        prompt: "Read this test conversation",
        kind: "once",
        schedule: new Date(Date.now() + 2000).toISOString(),
        timezone: "UTC",
      },
    },
    { stopReason: "toolUse" },
  ),
]);
const models = createModels();
models.setProvider(faux.provider);
const app = await Runtime.open({
  dir: process.argv[2],
  gateway: { catalog: async () => [] },
  models,
});
const create = app.tasks.create.bind(app.tasks);
app.tasks.create = async (...args) => {
  const task = await create(...args);
  console.log(`TASK_COMMITTED ${JSON.stringify(task)}`);
  // Simulate death after SQLite committed the schedule but before Durable got the result.
  await new Promise(() => {});
  return task;
};
const id = await app.create();
app.store.run(
  "INSERT OR IGNORE INTO credentials VALUES ('telegram:bot',?)",
  JSON.stringify({ botId: 123456, token: "123456:synthetic-test" }),
);
app.store.run("INSERT OR IGNORE INTO telegram VALUES (?,?,?)", "42", id, "42");
app.store.run(
  "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
  "42",
  "42",
  id,
);
app.store.run(
  "INSERT OR IGNORE INTO telegram_conversations VALUES (?,?,?)",
  id,
  "42",
  "42",
);
app.store.run(
  "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  "telegram:connection",
  JSON.stringify({
    enabled: true,
    bot: { id: 123456 },
    userId: "42",
    chatId: "42",
    conversationId: id,
  }),
);
await app.submit(
  id,
  "create-crash",
  "Remind me once at the specified UTC time",
  "telegram",
  "42",
);
setInterval(() => {}, 1000);
