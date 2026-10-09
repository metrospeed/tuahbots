import { openai } from "../agent/llm.js";
import { config } from "../config.js";

/**
 * A second opinion before hanging up. Spotting a goodbye from the words alone
 * can't tell a real ending from a receptionist's "I'll transfer you, have a
 * great day", a relayed "she'll talk to you later" or an agent that said
 * goodbye and then asked the caller to choose a time. The agent model reads
 * the end of the transcript and decides.
 */
export const CALL_OVER_PROMPT = `You check whether a phone call is finished. You get the end of a call transcript between an AI assistant ("Assistant") and the other person; "Backend result" lines are work the assistant did in the background. The assistant or the other person seems to have said goodbye and the line has gone quiet.

Answer OVER if the conversation has clearly ended: goodbyes were exchanged, or the assistant took its leave, and nothing is still pending.

Answer CONTINUE if anything is still open, for example:
- the other person is transferring the call, putting it on hold, or asked to wait or hold on;
- someone asked a question, or asked the other to choose, confirm or provide something, and it hasn't been answered;
- the other person started a new request after the goodbye;
- the "goodbye" was quoted, relayed for someone else, or part of a sentence rather than a farewell.

When unsure, answer CONTINUE. Reply with exactly one word: OVER or CONTINUE.`;

/** How long to wait for the answer before deciding without it. */
const TIMEOUT_MS = 6_000;

/** true: over; false: keep the call going; null: no usable answer (error, timeout). */
export async function isCallOver(transcript: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const response = await openai.responses.create(
      {
        model: config.agent.model,
        instructions: CALL_OVER_PROMPT,
        input: `Transcript (most recent last):\n${transcript}`,
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
        store: false,
      },
      { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) },
    );
    const answer = response.output_text.trim().toUpperCase();
    if (answer.startsWith("OVER")) return true;
    if (answer.startsWith("CONTINUE")) return false;
    return null;
  } catch (err) {
    console.warn("Call-over check failed", (err as Error).message);
    return null;
  }
}
