import crypto from "node:crypto";
import { config } from "../config.js";
import { openSecret, sealSecret } from "../secrets.js";

/** Time-based one-time passwords (RFC 6238): SHA-1, 6 digits, 30-second steps. */
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function currentCounter(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpCode(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Check a code against the current step and one step either side (clock
 * drift). Returns the matching counter, or null. Codes at or before
 * `lastUsedCounter` are rejected so a code can't be replayed.
 */
export function verifyTotp(secret: string, code: string, lastUsedCounter: number, now = Date.now()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const counter = currentCounter(now);
  for (const c of [counter - 1, counter, counter + 1]) {
    if (c <= lastUsedCounter) continue;
    const expected = Buffer.from(totpCode(secret, c));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return c;
  }
  return null;
}

export function otpauthUri(secret: string): string {
  const issuer = `${config.agent.name} admin`;
  const label = encodeURIComponent(`${issuer}:admin`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Secret encryption -------------------------------------------------------

/** AES-256-GCM, so a database dump alone doesn't reveal the 2FA secret. */
export function encryptSecret(plain: string): string {
  return sealSecret(plain, "admin-totp-secret");
}

export function decryptSecret(enc: string): string | null {
  return openSecret(enc, "admin-totp-secret");
}

// ---- Recovery codes ----------------------------------------------------------

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
}
