import crypto from "node:crypto";
import { config } from "./config.js";
import { addMessage, pool, queryOne, type Conversation, type Message } from "./db/index.js";
import { toE164 } from "./phone.js";

/**
 * Texting through httpSMS (https://httpsms.com). An Android phone running the
 * httpSMS app sends texts the API queues and forwards the texts it receives
 * to our webhook (/httpsms/webhook), so texts go over that phone's own plan.
 */

/** Longest text the agent sends; Android splits it into parts. */
export const MAX_TEXT_LENGTH = 1200;

export function smsConfigured(): boolean {
  return !!(config.httpsms.apiKey && config.httpsms.phoneNumber && config.httpsms.webhookSigningKey);
}

/** The httpSMS phone's number in E.164, however it was written in .env. */
export function smsPhoneNumber(): string {
  return toE164(config.httpsms.phoneNumber) ?? config.httpsms.phoneNumber;
}

export class SmsSendError extends Error {}

/** Queue a text on the httpSMS phone. Returns httpSMS's message id. */
export async function sendSms(to: string, content: string, requestId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.httpsms.apiBaseUrl}/v1/messages/send`, {
      method: "POST",
      headers: { "x-api-key": config.httpsms.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ from: smsPhoneNumber(), to, content, request_id: requestId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SmsSendError(`httpSMS could not be reached (${(err as Error).message})`);
  }
  const body = (await res.json().catch(() => null)) as { message?: string; data?: { id?: string } } | null;
  if (!res.ok || !body?.data?.id) {
    // Never echo the API key; httpSMS error messages don't contain it.
    throw new SmsSendError(`httpSMS refused the text (HTTP ${res.status}${body?.message ? `: ${body.message}` : ""})`);
  }
  return body.data.id;
}

/** request_id we give httpSMS for a stored message, echoed back in failure webhooks. */
const requestIdFor = (messageId: number) => `tuah-msg-${messageId}`;
export function messageIdFromRequestId(requestId: unknown): number | null {
  const m = /^tuah-msg-(\d+)$/.exec(String(requestId ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Store a text from the agent in a conversation and send it. If httpSMS
 * refuses it, the failure is logged in the conversation and thrown.
 */
export async function sendTextMessage(conversation: Conversation, to: string, body: string): Promise<Message> {
  const text = body.trim().slice(0, MAX_TEXT_LENGTH);
  const message = await addMessage(conversation.id, "assistant", text, undefined, {});
  try {
    const smsId = await sendSms(to, text, requestIdFor(message.id));
    await pool.query("UPDATE messages SET sms_id = $2 WHERE id = $1", [message.id, smsId]);
    return { ...message, sms_id: smsId };
  } catch (err) {
    await addMessage(conversation.id, "event", `Text could not be sent: ${(err as Error).message}`);
    throw err;
  }
}

/** The stored message a delivery webhook is about. */
export async function findSentText(requestId: unknown, smsId: unknown): Promise<Message | undefined> {
  const id = messageIdFromRequestId(requestId);
  if (id) {
    const byRequest = await queryOne<Message>("SELECT * FROM messages WHERE id = $1 AND via = 'sms' AND role = 'assistant'", [id]);
    if (byRequest) return byRequest;
  }
  return smsId ? queryOne<Message>("SELECT * FROM messages WHERE sms_id = $1 AND role = 'assistant'", [String(smsId)]) : undefined;
}

// ---- Webhook signatures ------------------------------------------------------

const b64url = (data: Buffer) => data.toString("base64url");

/** Sign an HS256 JWT the way httpSMS signs its webhooks (used by tests). */
export function signWebhookToken(claims: Record<string, unknown>, key = config.httpsms.webhookSigningKey): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(crypto.createHmac("sha256", key).update(`${head}.${body}`).digest());
  return `${head}.${body}.${signature}`;
}

/**
 * httpSMS sends `Authorization: Bearer <JWT>`, signed HS256 with the webhook's
 * signing key and valid for 10 minutes. Accept only a valid, unexpired token.
 */
export function verifyWebhookAuth(header: string | undefined, key = config.httpsms.webhookSigningKey, now = Date.now()): boolean {
  if (!key) return false;
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  const [head, body, signature, ...rest] = token?.split(".") ?? [];
  if (!head || !body || !signature || rest.length) return false;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    if (header?.alg !== "HS256") return false;
    const expected = crypto.createHmac("sha256", key).update(`${head}.${body}`).digest();
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const seconds = now / 1000;
    const skew = 60;
    if (typeof claims?.exp !== "number" || claims.exp < seconds - skew) return false;
    if (typeof claims.nbf === "number" && claims.nbf > seconds + skew) return false;
    return true;
  } catch {
    return false;
  }
}
