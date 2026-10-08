import { loadPromptOverrides } from "./agent/prompts.js";
import { createServer } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { startRecordingSweeper } from "./recordings.js";

await migrate();
await loadPromptOverrides();
startRecordingSweeper();
createServer().listen(config.port, () => console.log(`Listening on :${config.port} (public ${config.publicBaseUrl})`));
