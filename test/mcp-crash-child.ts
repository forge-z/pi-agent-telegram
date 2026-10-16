import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { McpGateway, mcpToolName } from "../src/mcp.js";
const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage(
    {
      type: "toolCall",
      id: "crash-mcp",
      name: mcpToolName("mock", "execute"),
      arguments: { code: "crash" },
    },
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("The result needs verification"),
]);
const models = createModels();
models.setProvider(faux.provider);
const app = await Runtime.open({
  dir: process.argv[2],
  gateway: new McpGateway([
    {
      name: "mock",
      url: process.argv[3],
      mode: "direct",
      readTools: [],
      actionTools: [],
    },
  ]),
  models,
});
const id = await app.create();
await app.submit(id, "mcp-crash", "Run the mock effect");
setInterval(() => {}, 1000);
