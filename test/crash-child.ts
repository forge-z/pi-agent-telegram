import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { Telegram } from "../src/telegram.js";
const dir = process.argv[2];
const faux = fauxProvider();
faux.setResponses([
  async () => {
    console.log("MODEL_PENDING");
    await new Promise(() => {});
    return fauxAssistantMessage("never");
  },
]);
const models = createModels();
models.setProvider(faux.provider);
const gateway = { catalog: async () => [] };
const app = await Runtime.open({ dir, gateway, models });
const id = await app.create();
await app.submit(id, "crash-request", "resume me");
app.store.run(
  "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('a',?,'mock','write','{}','running')",
  id,
);
console.log("ACTION_PENDING");
app.store.run(
  "INSERT INTO deliveries(id,chat,text) VALUES ('crash-delivery','100','hello')",
);
const telegram = new Telegram(
  app,
  {
    send: async () => {
      appendFileSync(`${dir}/effects.log`, "send\n");
      console.log("DELIVERY_PENDING");
      await new Promise(() => {});
      return {};
    },
  },
  ["42"],
  ["100"],
);
void telegram.flush();
setInterval(() => {}, 1000);
