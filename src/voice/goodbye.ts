/**
 * Spotting the end of a call from the transcript, so the call hangs up after
 * a goodbye even if GPT-Live never delegates "hang up".
 */

// A farewell, then at most two short words ("Goodbye, Mr. Smith!", "Bye for now.").
const FAREWELL_AT_END = new RegExp(
  String.raw`\b(good-?\s?bye|bye(?:[- ]bye)?|bye now|take care|good ?night|all the best|see you (?:later|soon|then)|talk (?:to you )?(?:soon|later)|` +
    String.raw`(?:have|enjoy) an? (?:great|good|nice|wonderful|lovely|fantastic) (?:day|one|night|evening|afternoon|morning|weekend|week|rest of your (?:day|evening|weekend|week))|` +
    String.raw`enjoy (?:the |your )?(?:day|evening|afternoon|weekend|week|rest of (?:your|the) (?:day|evening|afternoon|weekend|week)))` +
    String.raw`\b[\s.!,…]*(?:\S{1,12}[\s.!,…]*){0,2}$`,
  "i",
);

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

/** Whether a transcript fragment has any words in it (line noise often comes through as "." or "…"). */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
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
 * Upper bounds that don't depend on the line going quiet. GPT-Live can keep
 * streaming (silent) audio and noise can be transcribed as words, so waiting
 * for silence alone could keep a finished call open until its time limit.
 */
export const GOODBYE_MAX_WAIT_MS = 12_000;
export const CALLER_GOODBYE_MAX_WAIT_MS = 12_000;
/** However much the other side adds after the agent's goodbye, the agent must answer within this. */
export const GOODBYE_ABSOLUTE_MAX_MS = 30_000;

/**
 * Decides when a call is over, from the raw transcript as it streams in. The
 * agent decides whether the conversation goes on: anything substantive it
 * says cancels a pending hang-up. What the other side says only delays it,
 * and only up to a limit, so an unrecognized "thanks, have a good one" or
 * line noise can't keep the line open.
 */
export class GoodbyeWatcher {
  /** The agent's words since the other side last said something substantive (for spotting a farewell). */
  private agentText = "";
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
  /** When the goodbye became pending; pushed back when the other side adds something. */
  private byeAt: number | null = null;
  /** When the goodbye first became pending; never pushed back. */
  private firstByeAt: number | null = null;

  agentSaid(delta: string, now: number): void {
    if (!delta) return;
    if (this.lastSpeaker !== "agent" && delta.trim()) {
      this.agentTurn = "";
      this.lastSpeaker = "agent";
    }
    this.agentText = (this.agentText + delta).slice(-300);
    this.agentTurn = (this.agentTurn + delta).slice(-300);
    // Whitespace joins words but isn't speech.
    if (!delta.trim()) return;
    this.lastSpeechAt = now;
    if (endsWithFarewell(this.agentText)) {
      this.agentBye = true;
      this.pending(now);
    } else if (this.byeAt === null || !isClosingReply(this.agentTurn)) {
      // The agent carried on (or is part-way through a sentence); nothing is pending.
      this.agentBye = false;
      this.callerBye = false;
      this.byeAt = this.firstByeAt = null;
    }
  }

  callerSaid(delta: string, now: number): void {
    if (!delta) return;
    if (this.lastSpeaker !== "caller" && hasWords(delta)) {
      this.callerTurn = "";
      this.lastSpeaker = "caller";
    }
    this.callerTurn = (this.callerTurn + delta).slice(-300);
    if (!hasWords(delta)) return;
    this.lastSpeechAt = now;
    if (endsWithFarewell(this.callerTurn)) {
      this.callerBye = true;
      this.pending(now);
    } else if (!isClosingReply(this.callerTurn)) {
      // Something substantive: a later farewell from the agent must come after it,
      // and a pending goodbye waits for the agent's answer.
      this.agentText = "";
      this.callerBye = false;
      if (this.agentBye) this.byeAt = now;
      else this.byeAt = this.firstByeAt = null;
    }
  }

  /** The agent's audible audio is still arriving (it can trail the transcript). */
  agentAudio(now: number): void {
    this.lastSpeechAt = Math.max(this.lastSpeechAt, now);
  }

  /** True once a goodbye has been said and the line has gone quiet, or a time limit has passed. */
  isOver(now: number): boolean {
    if (this.byeAt === null || this.firstByeAt === null) return false;
    const quiet = now - this.lastSpeechAt;
    const pendingFor = now - this.byeAt;
    if (this.agentBye) {
      if (now - this.firstByeAt >= GOODBYE_ABSOLUTE_MAX_MS) return true;
      const callerAddedMore = this.lastSpeaker === "caller" && !this.callerBye && !isClosingReply(this.callerTurn);
      return quiet >= (callerAddedMore ? ANSWER_WAIT_MS : GOODBYE_QUIET_MS) || pendingFor >= GOODBYE_MAX_WAIT_MS;
    }
    return this.callerBye && (quiet >= CALLER_GOODBYE_QUIET_MS || pendingFor >= CALLER_GOODBYE_MAX_WAIT_MS);
  }

  /** Who said the goodbye, for the call log. */
  get endedBy(): "agent" | "caller" {
    return this.agentBye ? "agent" : "caller";
  }

  private pending(now: number): void {
    this.byeAt ??= now;
    this.firstByeAt ??= now;
  }
}

/** Decode one G.711 μ-law byte to the magnitude of its 16-bit sample. */
function mulawMagnitude(byte: number): number {
  const u = ~byte & 0xff;
  return ((((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7)) - 0x84;
}

/** Mean sample level below which μ-law audio is treated as silence (about -46 dBFS). */
export const AUDIBLE_MEAN_LEVEL = 160;

/** Whether a chunk of 8 kHz μ-law audio has speech in it, rather than silence or a faint hiss. */
export function isAudibleMulaw(audio: Buffer): boolean {
  if (!audio.length) return false;
  let sum = 0;
  for (const byte of audio) sum += mulawMagnitude(byte);
  return sum / audio.length >= AUDIBLE_MEAN_LEVEL;
}
