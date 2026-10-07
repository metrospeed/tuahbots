import { config } from "../config.js";
import { prewarmLiveCall } from "./live.js";
import { createRelaySession, type RelaySession } from "./sessions.js";
import { buildCallTwiml } from "./twiml.js";

/**
 * TwiML that plays the greeting and then hands the call to the voice engine.
 * With GPT-Live, the session is started now, while the greeting plays, so the
 * model is ready the instant the greeting ends.
 */
export function connectCall(session: RelaySession): string {
  const token = createRelaySession(session);
  if (config.voice.engine === "gpt-live") prewarmLiveCall(token, session);
  return buildCallTwiml(token, session.greeting);
}
