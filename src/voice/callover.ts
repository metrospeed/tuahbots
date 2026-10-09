import { complete } from "../agent/llm.js";
import { redact } from "../agent/provider.js";

/**
 * A second opinion before hanging up. Spotting a goodbye from the words alone
 * can't tell a real ending from a receptionist's "I'll transfer you, have a
 * great day", a relayed "she'll talk to you later" or an agent that said
 * goodbye and then asked the caller to choose a time. The agent model reads
 * the end of the transcript and decides.
 */
export const CALL_OVER_PROMPT = `You check whether a phone call is finished. You get the end of a call transcript between an AI assistant ("Assistant") and the other person; "Backend result" lines are work the assistant did in the background. The assistant or the other person seems to have said goodbye, and you're told how long the line has been quiet since.

Answer OVER if the conversation has ended and nothing is still pending, for example:
- goodbyes were exchanged, or the assistant took its leave;
- the other person said goodbye and the assistant has nothing left to do or say;
- the assistant closed with something like "Anything else? If not, have a great day!" and nobody has said anything since.

Answer CONTINUE if something is still open, for example:
- the other person is transferring the call, putting it on hold, or asked to wait or hold on;
- someone asked a real question, or asked the other to choose, confirm or provide something, and it hasn't been answered yet;
- the other person started a new request after the goodbye;
- the "goodbye" was quoted, relayed for someone else, or part of a sentence rather than a farewell.

Words that have nothing to do with the call (a TV or radio in the background, line noise) don't count. The longer the line has been quiet, the less likely anything is still pending, unless a transfer or hold is in progress. Reply with exactly one word: OVER or CONTINUE.`;

/** How long to wait for the answer before deciding without it. */
const TIMEOUT_MS = 6_000;

/** true: over; false: keep the call going; null: no usable answer (error, timeout). */
export async function isCallOver(transcript: string, quietSeconds: number, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const text = await complete(
      CALL_OVER_PROMPT,
      `Transcript (most recent last):\n${transcript}\n\n[The line has been quiet for ${quietSeconds} seconds since the last words.]`,
      {
        maxTokens: 2000,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const answer = text.toUpperCase();
    if (answer.startsWith("OVER")) return true;
    if (answer.startsWith("CONTINUE")) return false;
    return null;
  } catch (err) {
    console.warn("Call-over check failed", redact((err as Error).message));
    return null;
  }
}
