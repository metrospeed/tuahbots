/**
 * Spotting the end of a call from the transcript, so the call hangs up after
 * a goodbye even if GPT-Live never delegates "hang up".
 */

// Common farewells. "Take care of it" is a promise, not a goodbye ("take care of yourself" is one).
const COMMON_FAREWELLS =
  String.raw`good-?\s?bye|bye(?:[- ]bye)?|bye now|take care(?!\s+of\b(?!\s+your?sel(?:f|ves)\b))|talk (?:to you )?(?:soon|later)|` +
  String.raw`have an? (?:great|good|nice|wonderful|lovely|fantastic) (?:day|one|night|evening|afternoon|morning|weekend|rest of (?:your|the) (?:day|evening|afternoon|night|weekend|week))`;
// Farewells that are also ordinary phrases ("Saturday is a good night", "all the best
// reviews", "see you later today"): they only count at the start of a sentence or
// after a closing word.
const PLAIN_FAREWELLS =
  String.raw`good ?night|all the best|see you (?:later|soon|then)|have an? (?:great|good|nice|wonderful|lovely|fantastic) week|` +
  String.raw`enjoy (?:the |your )?(?:day|evening|afternoon|weekend|week|rest of (?:your|the) (?:day|evening|afternoon|weekend|week))`;
// A farewell, then at most two short words, then the end.
const COMMON_FROM_HERE = new RegExp(String.raw`^(?:${COMMON_FAREWELLS})\b((?:[\s.!,…]*[^\s?]{1,12}){0,2})[\s.!,…]*$`, "i");
const PLAIN_FROM_HERE = new RegExp(String.raw`^(?:${PLAIN_FAREWELLS})\b((?:[\s.!,…]*[^\s?]{1,12}){0,2})[\s.!,…]*$`, "i");
const FAREWELL_STARTS = new RegExp(String.raw`\b(?:${COMMON_FAREWELLS}|${PLAIN_FAREWELLS})`, "gi");
/** Words that may follow a farewell, besides a name ("Goodbye, Mr. Smith!", "Bye for now", "See you then, everyone"). */
const AFTER_FAREWELL = new Set([
  "now", "then", "too", "for", "to", "you", "all", "everyone", "everybody", "folks", "guys", "again", "bye", "there",
  "okay", "ok", "see", "later", "soon", "today", "tonight", "my", "friend", "buddy", "sir", "maam", "mate", "take", "care",
  "of", "yourself", "yourselves",
]);
const BEFORE_PLAIN_FAREWELL = /(?:^|[.!,…;:]|\b(?:okay|ok|alright|all right|thanks|thank you|you too|and|well|so|great|perfect|bye))$/i;
// Passing a message on is not saying goodbye: "I'll tell her good night", "she said she'll talk to you later".
// (Anything subtler is left to the check in callover.ts.)
const REPORTED = /\b(?:tell|tells|told|telling|say|says|said|saying|asked|asks|text|texting|wish|wishes|wishing|message|remind|reminded)\b/i;
// Someone else's plans or advice ("they'll talk to you later", "you should have a great weekend",
// "tell her to have a great day"): only "I/we will …" is the agent taking its leave.
const MODAL_BEFORE = /\b([\p{L}'’]+?)(?:['’]ll|\s+(will|would|should|could|can|might|must|won't|can't|don't|doesn't|didn't|to))\s*$/iu;

function farewellContextOk(before: string): boolean {
  const sentence = before.split(/[.!?…]/).pop() ?? "";
  // "Okay, I'll tell him, thanks, goodbye" is a goodbye; "she said she'll talk to you later" isn't.
  const clause = sentence.split(/[,;:]/).pop() ?? "";
  if (REPORTED.test(clause)) return false;
  const modal = MODAL_BEFORE.exec(sentence);
  if (!modal) return true;
  return ["i", "we"].includes(modal[1].toLowerCase()) && ["will", "can", undefined].includes(modal[2]?.toLowerCase());
}

function trailingOk(trailing: string): boolean {
  const words = trailing.match(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu) ?? [];
  return words.every((w) => AFTER_FAREWELL.has(w.replace(/[.'’]/g, "").toLowerCase()) || /^\p{Lu}/u.test(w));
}

/** The words end with a goodbye ("…Thanks so much, bye!"). */
export function endsWithFarewell(text: string): boolean {
  // Only the tail counts: "before I say goodbye, one more thing" is not a goodbye.
  const tail = text.trim().slice(-80);
  if (tail.endsWith("?")) return false;
  for (const start of tail.matchAll(FAREWELL_STARTS)) {
    const from = tail.slice(start.index);
    const before = tail.slice(0, start.index).trimEnd();
    const common = COMMON_FROM_HERE.exec(from);
    if (common && trailingOk(common[1]) && farewellContextOk(before)) return true;
    const plain = PLAIN_FROM_HERE.exec(from);
    if (plain && trailingOk(plain[1]) && BEFORE_PLAIN_FAREWELL.test(before) && farewellContextOk(before)) return true;
  }
  return false;
}

const FAREWELL_FIRST = /^[\s"“]*(?:good-?\s?bye|bye(?:[- ]bye)?|good ?night|take care(?!\s+of\b))\b([^?]*)$/i;

/** A turn that opens with a goodbye and only adds a few words ("Bye, see you tomorrow!", "Good night, Mark, sleep well!"). */
export function startsWithFarewell(turn: string): boolean {
  const m = FAREWELL_FIRST.exec(turn.trim());
  return !!m && (m[1].match(/[\p{L}\p{N}'’]+/gu) ?? []).length <= 8;
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

/** The last few words, to judge what someone just said rather than everything since they started. */
function lastWords(text: string, n: number): string {
  return (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).slice(-n).join(" ");
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
/**
 * However much the other side adds after the agent's goodbye, the agent must
 * answer within this; checked only once they pause, so nobody is cut off mid-sentence.
 */
export const GOODBYE_ABSOLUTE_MAX_MS = 30_000;
/** "A pause" for the limit above: long enough for GPT-Live to start answering. */
export const CALLER_PAUSE_MS = 5_000;
/** Ends the call even if words (or noise transcribed as words) never stop. */
export const GOODBYE_BACKSTOP_MS = 90_000;

/**
 * Spots when a call looks over, from the raw transcript as it streams in;
 * LiveCall then confirms with the agent model (callover.ts) before hanging up. The
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
  private lastCallerWordsAt = 0;
  /** The agent's latest words ended in a goodbye. */
  private agentBye = false;
  /** The other side said goodbye. */
  private callerBye = false;
  /** After the agent's goodbye the other side said something more; the agent hasn't answered yet ("Mhm" doesn't count). */
  private answerOwed = false;
  /** When the agent, and the other side, last said a farewell. */
  private agentFarewellAt = -Infinity;
  private callerFarewellAt = -Infinity;
  /** The agent is relaying a result after its goodbye; that doesn't take the goodbye back. */
  private relaying = false;
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
    const farewell = endsWithFarewell(this.agentText) || startsWithFarewell(this.agentTurn);
    if (farewell) {
      this.agentBye = true;
      this.answerOwed = false;
      this.agentFarewellAt = now;
      this.pending(now);
    } else if (this.relaying && this.agentBye && !this.agentTurn.trim().endsWith("?")) {
      // Relaying a result after its goodbye ("All done, it's moved to Friday."): still a goodbye, unless it asks something.
    } else if (this.byeAt === null || !isClosingReply(this.agentTurn)) {
      // The agent carried on (or is part-way through a sentence); nothing is pending.
      this.agentBye = false;
      this.callerBye = false;
      this.answerOwed = false;
      this.byeAt = this.firstByeAt = null;
    }
  }

  callerSaid(delta: string, now: number): void {
    if (!delta) return;
    if (this.lastSpeaker !== "caller" && hasWords(delta)) {
      this.callerTurn = "";
      this.lastSpeaker = "caller";
      this.relaying = false;
      // The agent had finished a sentence: a farewell has to be in what it says next.
      if (/[.!?…]["”’']?\s*$/.test(this.agentText)) this.agentText = "";
    }
    this.callerTurn = (this.callerTurn + delta).slice(-300);
    if (!hasWords(delta)) {
      // A trailing "?" can turn "...a good night" into a question.
      if (this.callerBye && !endsWithFarewell(this.callerTurn)) {
        this.callerBye = false;
        if (!this.agentBye) this.byeAt = this.firstByeAt = null;
      }
      return;
    }
    this.lastSpeechAt = now;
    const farewell = endsWithFarewell(this.callerTurn);
    // Something substantive ("wait, can you also tell her good night"): a later farewell
    // from the agent must come after it, and a pending goodbye waits for the agent's answer.
    // Judged on the latest words, so a string of "Okay." from a noisy line stays a closing.
    const substantive = !isClosingReply(lastWords(this.callerTurn, 4));
    if (substantive) {
      this.agentText = "";
      this.lastCallerWordsAt = now;
    }
    if (farewell) {
      this.callerBye = true;
      this.callerFarewellAt = now;
      this.pending(now);
    } else if (substantive) {
      this.callerBye = false;
    }
    if (substantive) {
      if (this.agentBye) {
        this.byeAt = now;
        this.answerOwed = true;
      } else if (!this.callerBye) {
        this.byeAt = this.firstByeAt = null;
      }
    }
  }

  /** The agent's audible audio is still arriving (it can trail the transcript). */
  agentAudio(now: number): void {
    this.lastSpeechAt = Math.max(this.lastSpeechAt, now);
  }

  /**
   * The conversation is still going on behind the scenes (a task the agent was
   * working on just finished): restart the goodbye timers so the agent can
   * relay the result before a pending goodbye ends the call.
   */
  extend(now: number): void {
    this.lastSpeechAt = Math.max(this.lastSpeechAt, now);
    if (this.byeAt !== null) this.byeAt = this.firstByeAt = now;
    if (this.agentBye) this.relaying = true;
  }

  /** Whether the agent has said a farewell since `since` (and not carried on after it). */
  agentSaidGoodbyeSince(since: number): boolean {
    return this.agentBye && this.agentFarewellAt >= since;
  }

  /** Whether a goodbye (from either side) is waiting to end the call. */
  get pendingGoodbye(): boolean {
    return this.byeAt !== null && (this.agentBye || this.callerBye);
  }

  /** When either side last said a farewell. */
  get lastFarewellAt(): number {
    return Math.max(this.agentFarewellAt, this.callerFarewellAt);
  }

  /** True once a goodbye has been said and the line has gone quiet, or a time limit has passed. */
  isOver(now: number): boolean {
    if (this.byeAt === null || this.firstByeAt === null) return false;
    const quiet = now - this.lastSpeechAt;
    const pendingFor = now - this.byeAt;
    if (this.agentBye) {
      const sinceFirst = now - this.firstByeAt;
      if (sinceFirst >= GOODBYE_BACKSTOP_MS) return true;
      if (sinceFirst >= GOODBYE_ABSOLUTE_MAX_MS && now - this.lastCallerWordsAt >= CALLER_PAUSE_MS) return true;
      return quiet >= (this.answerOwed ? ANSWER_WAIT_MS : GOODBYE_QUIET_MS) || pendingFor >= GOODBYE_MAX_WAIT_MS;
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

/** Whether a chunk of 8 kHz μ-law audio has sound in it, rather than silence or a faint hiss. */
export function isAudibleMulaw(audio: Buffer): boolean {
  if (!audio.length) return false;
  let sum = 0;
  for (const byte of audio) sum += mulawMagnitude(byte);
  return sum / audio.length >= AUDIBLE_MEAN_LEVEL;
}

/**
 * Tracks whether the other side's line has sustained sound (talking, hold
 * music) rather than dead air, from Twilio's 20 ms inbound frames. Brief
 * clicks don't count.
 */
export class LineSound {
  private level = 0;

  /** Feed one inbound frame; returns true while most of the last half second or so was audible. */
  frame(audio: Buffer): boolean {
    this.level = this.level * 0.95 + (isAudibleMulaw(audio) ? 0.05 : 0);
    return this.level > 0.5;
  }
}
