import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Encryption for secrets kept in the database (the admin's 2FA secret, AI
 * provider API keys), so a database dump or backup alone doesn't reveal them.
 * AES-256-GCM with a key derived from SESSION_SECRET; each `purpose` gets its
 * own key, so a value sealed for one use can't be opened as another.
 * `context` is authenticated too: a sealed API key is bound to the endpoint
 * it was saved for and won't open if the row is copied elsewhere.
 */
function key(purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", config.admin.sessionSecret, "tuah", purpose, 32));
}

export function sealSecret(plain: string, purpose: string, context = ""): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(purpose), iv);
  if (context) cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** The plaintext, or null if it was sealed with another key, purpose or context, or tampered with. */
export function openSecret(sealed: string, purpose: string, context = ""): string | null {
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(purpose), iv);
    if (context) decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What the admin panel shows for a saved key: only its last 4 characters. */
export function secretHint(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : "";
}

/**
 * Strip API keys from text that may be shown or logged (provider error
 * messages sometimes echo part of the key). `known` are the exact keys in use.
 */
export function redactSecrets(text: string, known: string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_*-]{8,}/g, "$1-[redacted]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
}
