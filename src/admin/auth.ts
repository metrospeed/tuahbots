import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { pool, queryOne } from "../db/index.js";
import { decryptSecret, encryptSecret, hashRecoveryCode, verifyTotp } from "./totp.js";

/**
 * Admin sign-in is two steps: the admin password, then a code from an
 * authenticator app (or a one-time recovery code). Each step has its own
 * signed cookie; a full session lasts 30 minutes and can be revoked by
 * bumping admin_auth.session_version (which logging out does).
 */
const SESSION_COOKIE = "tuah_admin";
const PENDING_COOKIE = "tuah_admin_pending";
export const SESSION_MINUTES = 30;
const PENDING_MINUTES = 5;

interface AdminAuth {
  totp_secret_enc: string | null;
  totp_last_counter: string; // BIGINT comes back as a string
  recovery_hashes: string[];
  session_version: number;
}

async function adminAuth(): Promise<AdminAuth> {
  return (await queryOne<AdminAuth>("SELECT * FROM admin_auth WHERE id = 1"))!;
}

function sign(kind: string, value: string): string {
  return crypto.createHmac("sha256", config.admin.sessionSecret).update(`${kind}:${value}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkPassword(password: string): boolean {
  return safeEqual(password, config.admin.password);
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.publicBaseUrl.startsWith("https://"),
    maxAge: maxAgeMs,
    path: "/admin",
  };
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** "version.expires.signature", valid while unexpired and the version is current. */
function makeToken(kind: string, version: number, minutes: number): string {
  const value = `${version}.${Date.now() + minutes * 60 * 1000}`;
  return `${value}.${sign(kind, value)}`;
}

async function tokenValid(kind: string, token: string | undefined): Promise<boolean> {
  const [version, expires, signature] = (token ?? "").split(".");
  if (!signature || !safeEqual(signature, sign(kind, `${version}.${expires}`))) return false;
  if (Number(expires) <= Date.now()) return false;
  return Number(version) === (await adminAuth()).session_version;
}

// ---- Step 1: password --------------------------------------------------------

/** After a correct password: remember that for a few minutes while the code is entered. */
export async function startPendingLogin(res: Response): Promise<void> {
  const { session_version } = await adminAuth();
  res.cookie(PENDING_COOKIE, makeToken("admin-pending", session_version, PENDING_MINUTES), cookieOptions(PENDING_MINUTES * 60 * 1000));
}

export function passwordStepDone(req: Request): Promise<boolean> {
  return tokenValid("admin-pending", readCookie(req, PENDING_COOKIE));
}

// ---- Step 2: authenticator code ------------------------------------------------

export async function twoFactorEnrolled(): Promise<boolean> {
  return !!(await adminAuth()).totp_secret_enc;
}

/**
 * Check an authenticator code (or a recovery code, which is then used up).
 * Accepted codes can't be reused.
 */
export async function checkSecondFactor(input: string): Promise<boolean> {
  const auth = await adminAuth();
  const secret = auth.totp_secret_enc ? decryptSecret(auth.totp_secret_enc) : null;
  if (!secret) return false;
  const counter = verifyTotp(secret, input, Number(auth.totp_last_counter));
  if (counter !== null) {
    // Only advance; a concurrent request with the same code loses the race.
    const updated = await pool.query("UPDATE admin_auth SET totp_last_counter = $1 WHERE id = 1 AND totp_last_counter < $1", [counter]);
    return (updated.rowCount ?? 0) === 1;
  }
  const hash = hashRecoveryCode(input);
  if (!auth.recovery_hashes.includes(hash)) return false;
  const used = await pool.query(
    "UPDATE admin_auth SET recovery_hashes = array_remove(recovery_hashes, $1) WHERE id = 1 AND $1 = ANY(recovery_hashes)",
    [hash],
  );
  return (used.rowCount ?? 0) === 1;
}

export async function recoveryCodesLeft(): Promise<number> {
  return (await adminAuth()).recovery_hashes.length;
}

/** Save a newly confirmed authenticator secret and recovery codes; signs out other admin sessions. */
export async function enrollTwoFactor(secret: string, counter: number, recoveryCodes: string[]): Promise<void> {
  await pool.query(
    `UPDATE admin_auth SET totp_secret_enc = $1, totp_last_counter = $2, recovery_hashes = $3,
       session_version = session_version + 1, updated_at = now() WHERE id = 1`,
    [encryptSecret(secret), counter, recoveryCodes.map(hashRecoveryCode)],
  );
}

export async function replaceRecoveryCodes(recoveryCodes: string[]): Promise<void> {
  await pool.query("UPDATE admin_auth SET recovery_hashes = $1, updated_at = now() WHERE id = 1", [recoveryCodes.map(hashRecoveryCode)]);
}

/** Remove 2FA (it's set up again at the next sign-in) and sign out every admin session. */
export async function resetTwoFactor(): Promise<void> {
  await pool.query(
    `UPDATE admin_auth SET totp_secret_enc = NULL, totp_last_counter = 0, recovery_hashes = '{}',
       session_version = session_version + 1, updated_at = now() WHERE id = 1`,
  );
}

// ---- Sessions -----------------------------------------------------------------

export async function startSession(res: Response): Promise<void> {
  const { session_version } = await adminAuth();
  res.clearCookie(PENDING_COOKIE, { path: "/admin" });
  res.cookie(SESSION_COOKIE, makeToken("admin-session", session_version, SESSION_MINUTES), cookieOptions(SESSION_MINUTES * 60 * 1000));
}

/** Log out: end every admin session, everywhere. */
export async function endAllSessions(res: Response): Promise<void> {
  await pool.query("UPDATE admin_auth SET session_version = session_version + 1 WHERE id = 1");
  res.clearCookie(SESSION_COOKIE, { path: "/admin" });
  res.clearCookie(PENDING_COOKIE, { path: "/admin" });
}

export function isLoggedIn(req: Request): Promise<boolean> {
  return tokenValid("admin-session", readCookie(req, SESSION_COOKIE));
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await isLoggedIn(req))) return res.redirect("/admin/login");
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

/** Brute-force guard for both sign-in steps: 5 failures per IP per 15 minutes. */
const attempts = new Map<string, { count: number; until: number }>();
export function loginThrottled(key: string): boolean {
  const entry = attempts.get(key);
  return !!entry && entry.count >= 5 && entry.until > Date.now();
}
export function recordFailedLogin(key: string): void {
  const entry = attempts.get(key);
  const fresh = !entry || entry.until < Date.now();
  attempts.set(key, { count: fresh ? 1 : entry!.count + 1, until: Date.now() + 15 * 60 * 1000 });
}
export function clearFailedLogins(key: string): void {
  attempts.delete(key);
}
