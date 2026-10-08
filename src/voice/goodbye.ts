/**
 * Spotting the end of a call from the transcript, so the call hangs up after
 * a goodbye even if GPT-Live never delegates "hang up".
 */

// A farewell, then at most two short words ("Goodbye, Mr. Smith!", "Bye for now.").
const FAREWELL_AT_END =
  /\b(good-?\s?bye|bye(?:[- ]bye)?|bye now|take care|talk (?:to you )?(?:soon|later)|have an? (?:great|good|nice|wonderful|lovely|fantastic) (?:day|one|night|evening|afternoon|morning|weekend|rest of your day))\b[\s.!,…]*(?:\S{1,12}[\s.!,…]*){0,2}$/i;

/** The words end with a goodbye ("…Thanks so much, bye!"). */
export function endsWithFarewell(text: string): boolean {
  // Only the tail counts: "before I say goodbye, one more thing" is not a goodbye.
  const tail = text.trim().slice(-80);
  if (tail.endsWith("?")) return false;
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

/** After the agent says goodbye, hang up once the line has been quiet this long. */
export const GOODBYE_QUIET_MS = 3_000;
/** After the other side says goodbye and the agent has nothing more to add. */
export const CALLER_GOODBYE_QUIET_MS = 5_000;
/**
 * After the agent's goodbye the other side said something more than a closing
 * ("wait, one more thing"): give the agent this long to answer before
 * treating the call as over anyway.
 */
export const ANSWER_WAIT_MS = 10_000;

/**
 * Decides when a call is over, from the raw transcript as it streams in. The
 * agent decides whether the conversation goes on: anything substantive it
 * says cancels a pending hang-up. What the other side says only delays it,
 * so an unrecognized "thanks, have a good one" can't keep the line open.
 */
export class GoodbyeWatcher {
  /** What the agent has said since the other side last spoke. */
  private agentTurn = "";
  /** What the other side has said since the agent last spoke. */
  private callerTurn = "";
  private lastSpeaker: "agent" | "caller" | "" = "";
  private lastSpeechAt = 0;
  /** The agent's latest words ended in a goodbye. */
  private agentBye = false;
  /** The other side said goodbye. */
  private callerBye = false;

  agentSaid(delta: string, now: number): void {
    if (this.lastSpeaker !== "agent") this.agentTurn = "";
    this.lastSpeaker = "agent";
    this.agentTurn = (this.agentTurn + delta).slice(-300);
    this.lastSpeechAt = now;
    if (endsWithFarewell(this.agentTurn)) {
      this.agentBye = true;
    } else if (!(this.callerBye || this.agentBye) || !isClosingReply(this.agentTurn)) {
      // The agent carried on (or is part-way through a sentence); nothing is pending.
      this.agentBye = false;
      this.callerBye = false;
    }
  }

  callerSaid(delta: string, now: number): void {
    if (!delta.trim()) return;
    if (this.lastSpeaker !== "caller") this.callerTurn = "";
    this.lastSpeaker = "caller";
    this.callerTurn = (this.callerTurn + delta).slice(-300);
    this.lastSpeechAt = now;
    this.callerBye = endsWithFarewell(this.callerTurn) || (this.callerBye && isClosingReply(this.callerTurn));
  }

  /** The agent's audio is still arriving (it can trail the transcript). */
  agentAudio(now: number): void {
    this.lastSpeechAt = Math.max(this.lastSpeechAt, now);
  }

  /** True once a goodbye has been said and the line has gone quiet long enough. */
  isOver(now: number): boolean {
    const quiet = now - this.lastSpeechAt;
    if (this.agentBye) {
      const callerAddedMore = this.lastSpeaker === "caller" && !this.callerBye && !isClosingReply(this.callerTurn);
      return quiet >= (callerAddedMore ? ANSWER_WAIT_MS : GOODBYE_QUIET_MS);
    }
    return this.callerBye && quiet >= CALLER_GOODBYE_QUIET_MS;
  }

  /** Who said the goodbye, for the call log. */
  get endedBy(): "agent" | "caller" {
    return this.agentBye ? "agent" : "caller";
  }
}
