import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { getUser, query, queryOne, type User } from "../db/index.js";

const COOKIE = "tuah_user";
const SESSION_DAYS = 180;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Give a user a fresh invite link. Any earlier link stops working and every
 * device signed in with it is signed out.
 */
export async function issueInviteLink(userId: number): Promise<string> {
  const token = crypto.randomBytes(24).toString("base64url");
  await query("UPDATE users SET login_token_hash = $2, session_version = session_version + 1 WHERE id = $1", [userId, hashToken(token)]);
  return `${config.publicBaseUrl}/join/${token}`;
}

export async function userForInviteToken(token: string): Promise<User | undefined> {
  return queryOne<User>("SELECT * FROM users WHERE login_token_hash = $1 AND active", [hashToken(token)]);
}

function sign(value: string): string {
  return crypto.createHmac("sha256", config.admin.sessionSecret).update(`user:${value}`).digest("base64url");
}

export function setUserCookie(res: Response, user: User): void {
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  const value = `${user.id}.${user.session_version}.${expires}`;
  res.cookie(COOKIE, `${value}.${sign(value)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicBaseUrl.startsWith("https://"),
    maxAge: SESSION_DAYS * 86400 * 1000,
    path: "/",
  });
}

export function clearUserCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

async function currentUser(req: Request): Promise<User | undefined> {
  const [id, version, expires, signature] = (readCookie(req) ?? "").split(".");
  if (!signature || Number(expires) < Date.now()) return undefined;
  const expected = Buffer.from(sign(`${id}.${version}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return undefined;
  const user = await getUser(Number(id));
  if (!user?.active || user.session_version !== Number(version)) return undefined;
  return user;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await currentUser(req);
  if (!user) {
    if (req.path.startsWith("/app/api/")) res.status(401).json({ error: "signed_out" });
    else res.status(401).send(signedOutPage());
    return;
  }
  // Writes must come from our own pages (JSON bodies also force a CORS preflight).
  if (req.method !== "GET") {
    const origin = req.header("origin");
    if (origin && origin !== new URL(config.publicBaseUrl).origin) {
      res.status(403).json({ error: "cross_origin" });
      return;
    }
  }
  req.user = user;
  next();
}

export function signedOutPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed out</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center;background:#f6f7f9;color:#1d2330}
@media (prefers-color-scheme:dark){body{background:#0f1218;color:#e6e8ec}}</style></head>
<body><div><h2>You're not signed in</h2><p>Open the invite link you were sent to use ${config.agent.name}.<br>If it no longer works, ask for a new one.</p></div></body></html>`;
}
