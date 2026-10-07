import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";

/**
 * Content Security Policy: only our own scripts run (no inline script or
 * event handlers), nothing can be loaded from or posted to other sites, and
 * no other site can embed our pages (clickjacking).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (config.publicBaseUrl.startsWith("https://")) {
    // Browsers that have visited once will only use HTTPS for the next year.
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

/** Our static scripts (src/web/assets, copied to dist/web/assets by the build). */
export function assetsRouter(): express.Router {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "web", "assets");
  const files = new Map<string, string>();
  for (const name of ["chat.js", "admin.js"]) files.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
  const router = express.Router();
  router.get("/assets/:name", (req, res) => {
    const body = files.get(req.params.name);
    if (!body) return void res.sendStatus(404);
    res.type("application/javascript").setHeader("Cache-Control", "public, max-age=300");
    res.send(body);
  });
  return router;
}
