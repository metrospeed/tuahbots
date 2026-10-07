import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

const COOKIE = "tuah_admin";
const SESSION_HOURS = 12;

function sign(value: string): string {
  return crypto.createHmac("sha256", config.admin.sessionSecret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(password: string): boolean {
  return safeEqual(password, config.admin.password);
}

export function setSessionCookie(res: Response): void {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const value = `${expires}.${sign(String(expires))}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.publicBaseUrl.startsWith("https://"),
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: "/admin",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/admin" });
}

function readCookie(req: Request): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isLoggedIn(req: Request): boolean {
  const value = readCookie(req);
  if (!value) return false;
  const [expires, signature] = value.split(".");
  if (!expires || !signature || !safeEqual(signature, sign(expires))) return false;
  return Number(expires) > Date.now();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isLoggedIn(req)) return res.redirect("/admin/login");
  // Same-origin check for state-changing requests (defense in depth with SameSite=Strict).
  if (req.method === "POST") {
    const origin = req.header("origin");
    if (origin && origin !== new URL(config.publicBaseUrl).origin) {
      res.status(403).send("Cross-origin request rejected");
      return;
    }
  }
  next();
}

/** Very small brute-force guard for the login form. */
const attempts = new Map<string, { count: number; until: number }>();
export function loginThrottled(ip: string): boolean {
  const entry = attempts.get(ip);
  return !!entry && entry.count >= 5 && entry.until > Date.now();
}
export function recordFailedLogin(ip: string): void {
  const entry = attempts.get(ip);
  const fresh = !entry || entry.until < Date.now();
  attempts.set(ip, { count: fresh ? 1 : entry!.count + 1, until: Date.now() + 15 * 60 * 1000 });
}
