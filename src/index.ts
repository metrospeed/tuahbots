import { loadPromptOverrides } from "./agent/prompts.js";
import { loadAiSettings } from "./agent/provider.js";
import { createServer } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { startRecordingSweeper } from "./recordings.js";
import { getSettings } from "./settings.js";

await migrate();
await loadPromptOverrides();
await loadAiSettings();
await getSettings(); // loads the admin's time zone for date formatting
startRecordingSweeper();
createServer().listen(config.port, () => console.log(`Listening on :${config.port} (public ${config.publicBaseUrl})`));
