import http from "node:http";
import express from "express";
import { adminRouter } from "./admin/routes.js";
import { config } from "./config.js";
import { smsRouter } from "./routes/sms.js";
import { voiceRouter } from "./routes/voice.js";
import { handleStreamUpgrade } from "./voice/live.js";
import { handleRelayUpgrade } from "./voice/relay.js";

export function createServer(): http.Server {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.send("ok"));
  app.get("/", (_req, res) => res.redirect("/admin"));
  app.use(smsRouter);
  app.use(voiceRouter);
  app.use(adminRouter);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).send("Internal error");
  });

  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    if (path === "/twilio/stream" && config.voice.engine === "gpt-live") return handleStreamUpgrade(req, socket, head);
    handleRelayUpgrade(req, socket, head);
  });
  return server;
}
