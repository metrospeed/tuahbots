import { createServer } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { startRecordingSweeper } from "./recordings.js";

await migrate();
startRecordingSweeper();
createServer().listen(config.port, () => console.log(`Listening on :${config.port} (public ${config.publicBaseUrl})`));
