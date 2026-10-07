import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { getUser, query, queryOne, type User } from "../db/index.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./passwords.js";

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
  await query(
    `UPDATE users SET login_token_hash = $2, login_token_expires_at = now() + interval '${INVITE_DAYS} days',
       session_version = session_version + 1 WHERE id = $1`,
    [userId, hashToken(token)],
  );
  return `${config.publicBaseUrl}/join/${token}`;
}

/** Invite and reset links stop working after this long (or when revoked). */
export const INVITE_DAYS = 7;

export async function userForInviteToken(token: string): Promise<User | undefined> {
  return queryOne<User>(
    "SELECT * FROM users WHERE login_token_hash = $1 AND active AND login_token_expires_at > now()",
    [hashToken(token)],
  );
}

/** Make a user's outstanding invite or reset link stop working. */
export async function revokeInviteLink(userId: number): Promise<void> {
  await query("UPDATE users SET login_token_hash = NULL, login_token_expires_at = NULL WHERE id = $1", [userId]);
}

/**
 * Finish an invite (or reset) link: save the user's login, use up the link,
 * and sign out any other device.
 */
export async function completeInvite(userId: number, email: string, password: string): Promise<User> {
  const user = await queryOne<User>(
    `UPDATE users SET email = $2, password_hash = $3, login_token_hash = NULL, login_token_expires_at = NULL,
       session_version = session_version + 1
     WHERE id = $1 RETURNING *`,
    [userId, email, await hashPassword(password)],
  );
  return user!;
}

/** The user for an email and password, or undefined. Takes the same time whether or not the email exists. */
export async function checkLogin(email: string, password: string): Promise<User | undefined> {
  const user = await queryOne<User>("SELECT * FROM users WHERE email = $1", [email]);
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
  return ok && user?.active && user.password_hash ? user : undefined;
}

export async function emailTaken(email: string, exceptUserId: number): Promise<boolean> {
  return !!(await queryOne("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, exceptUserId]));
}

/** Change a signed-in user's password and sign out their other devices. */
export async function changePassword(userId: number, password: string): Promise<User> {
  const user = await queryOne<User>(
    "UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING *",
    [userId, await hashPassword(password)],
  );
  return user!;
}

/**
 * Limits repeated failures per key (IP, email): after `max` failures within
 * the window, further attempts are refused until it passes.
 */
export class Throttle {
  private failures = new Map<string, { count: number; until: number }>();
  constructor(private max: number, private windowMs: number) {}
  blocked(key: string): boolean {
    const entry = this.failures.get(key);
    return !!entry && entry.count >= this.max && entry.until > Date.now();
  }
  fail(key: string): void {
    const entry = this.failures.get(key);
    const fresh = !entry || entry.until < Date.now();
    this.failures.set(key, { count: fresh ? 1 : entry!.count + 1, until: Date.now() + this.windowMs });
    if (this.failures.size > 10_000) this.failures.clear();
  }
  reset(key: string): void {
    this.failures.delete(key);
  }
}

/** Reject form posts from other sites (login CSRF). */
export function fromOurSite(req: Request): boolean {
  const origin = req.header("origin");
  return !origin || origin === new URL(config.publicBaseUrl).origin;
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

export async function currentUser(req: Request): Promise<User | undefined> {
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
    if (req.originalUrl.startsWith("/app/api/")) res.status(401).json({ error: "signed_out" });
    else if (req.method === "GET") res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    else res.redirect("/login");
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
