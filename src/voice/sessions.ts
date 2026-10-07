import crypto from "node:crypto";

/**
 * What a ConversationRelay websocket is for. A random token is minted when we
 * hand Twilio the TwiML and must be presented when the websocket connects, so
 * only calls we set up can open an agent session.
 */
export type RelaySession =
  | { mode: "user"; conversationId: number; userId: number; greeting: string }
  | {
      mode: "task";
      conversationId: number;
      taskId: number;
      userId: number;
      greeting: string;
      /** Calls the agent placed: after the greeting, the agent keeps talking instead of waiting for a reply. */
      speakFirst?: boolean;
    };

const TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, { session: RelaySession; expires: number }>();

export function createRelaySession(session: RelaySession): string {
  const token = crypto.randomBytes(24).toString("base64url");
  sessions.set(token, { session, expires: Date.now() + TTL_MS });
  return token;
}

/** One-time lookup: the token is consumed. */
export function takeRelaySession(token: string): RelaySession | undefined {
  const entry = sessions.get(token);
  sessions.delete(token);
  if (!entry || entry.expires < Date.now()) return undefined;
  return entry.session;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sessions) if (entry.expires < now) sessions.delete(token);
}, 60_000).unref();
