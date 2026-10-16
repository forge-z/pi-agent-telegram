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
const gateway = {
  call: async (
    _s: string,
    _t: string,
    _args: Record<string, unknown>,
    kind: "read" | "action",
  ) => {
    if (kind === "read") return { content: [] };
    appendFileSync(`${dir}/effects.log`, "write\n");
    console.log("ACTION_PENDING");
    await new Promise(() => {});
    return {};
  },
};
const app = await Runtime.open({ dir, gateway, models });
const id = await app.create();
await app.submit(id, "crash-request", "resume me");
await app.actions.read(id, "mock", "read", {});
const action = app.actions.propose(id, 999, "mock", "write", {});
void app.actions.decide(id, action.id, "approve");
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
