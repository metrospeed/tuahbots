/**
 * Spotting the end of a call from the transcript, so the call hangs up after
 * the agent says goodbye even if GPT-Live never delegates "hang up".
 */

const FAREWELL_AT_END =
  /\b(good-?\s?bye|bye(?:[- ]bye)?|bye now|take care|talk (?:to you )?(?:soon|later)|have an? (?:great|good|nice|wonderful|lovely|fantastic) (?:day|one|night|evening|afternoon|morning|weekend|rest of your day))\b[\s.!,…]*(?:\S{0,12})?[\s.!]*$/i;

/** The agent's words end with a goodbye ("…Thanks so much, bye!"). */
export function endsWithFarewell(text: string): boolean {
  // Only the tail counts: "before I say goodbye, one more thing" is not a goodbye.
  const tail = text.trim().slice(-80);
  return FAREWELL_AT_END.test(tail);
}

const CLOSING_WORDS = new Set([
  "bye", "byebye", "goodbye", "good", "thanks", "thank", "you", "too", "ok", "okay", "alright", "all", "right",
  "cheers", "take", "care", "great", "perfect", "sounds", "have", "a", "nice", "day", "same", "to", "yep", "yeah",
  "yes", "mhm", "mm", "uh", "huh", "sure", "will", "do", "appreciate", "it", "so", "much", "night", "later", "see", "ya",
]);

/** The other person's reply is just a closing ("Thanks, you too, bye!"), not a new topic. */
export function isClosingReply(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/-/g, "").split(/\s+/).filter(Boolean);
  return words.length <= 10 && words.every((w) => CLOSING_WORDS.has(w.replace(/'/g, "")));
}
