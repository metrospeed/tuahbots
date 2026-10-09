import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import OpenAI from "openai";
import { TranscriptGrouper, type TranscriptSegment } from "openai/lib/live/transcript-grouper";
import type { ServerEvent, SessionConfig } from "openai/resources/live/live";
import { LiveWS } from "openai/resources/live/ws";
import { WebSocket, WebSocketServer } from "ws";
import { runAgent, type AgentTool, type ContentPart } from "../agent/llm.js";
import { recentChatContext, taskBrief, userDetails } from "../agent/context.js";
import {
  LIVE_BACKEND_ADDENDUM,
  LIVE_SPEAK_FIRST,
  liveTaskInstructions,
  liveUserInstructions,
  taskCallPrompt,
  USER_ASSISTANT_PROMPT,
} from "../agent/prompts.js";
import { taskCallTools, userTools, type CallControls } from "../agent/tools.js";
import { config } from "../config.js";
import { addMessage, getTask, getUser, query, type User } from "../db/index.js";
import { twilioClient } from "../twilio.js";
import { dtmfAudio } from "./dtmf.js";
import { takeRelaySession, type RelaySession } from "./sessions.js";
import { GoodbyeWatcher, hasWords, isAudibleMulaw, LineSound } from "./goodbye.js";
import { finalizeCall } from "./summary.js";
import { getSettings } from "../settings.js";

/**
 * GPT-Live voice calls. Twilio Media Streams sends the caller's 8 kHz μ-law
 * audio here; we forward it to a GPT-Live session in the same format and play
 * its speech back. GPT-Live handles the conversation itself and delegates
 * tasks (placing calls, pressing keys, hanging up) to us, which the agent model
 * carries out with the same tools the chat agent uses.
 */
export const streamServer = new WebSocketServer({ noServer: true });
const openai = config.voice.engine === "gpt-live" ? new OpenAI() : undefined;

/** Twilio sends 20 ms frames; buffer about 3 s of audio while GPT-Live starts. */
const MAX_PENDING_FRAMES = 150;
/** Twilio must identify the call (with our token) promptly or we drop it. */
const START_TIMEOUT_MS = 10_000;
/** A prewarmed session whose call never streams (hung up during the greeting) is dropped. */
const PREWARM_TTL_MS = 90_000;
/** The agent's speech counts as finished after this much silence from GPT-Live. */
const SPEECH_SETTLE_MS = 800;
/** Upper bound on waiting for a goodbye to finish before hanging up anyway. */
const MAX_GOODBYE_MS = 15_000;
/** When GPT-Live is asked to say goodbye but doesn't (and goes quiet), hang up after this much silence anyway. */
const SILENT_GOODBYE_MS = 8_000;
/** Upper bound on waiting for GPT-Live to say a goodbye it was asked for. */
const MAX_ASKED_GOODBYE_MS = 20_000;
/** After the goodbye watcher fires, the agent is done; don't wait long for audible noise to stop. */
const MAX_AFTER_GOODBYE_MS = 8_000;
/** A goodbye never ends the call while the agent is doing something for the caller, unless that takes longer than this. */
const DELEGATION_HOLD_MAX_MS = 60_000;
/** If the mark never comes back, hang up anyway after this long. */
const MARK_TIMEOUT_MS = 8_000;
/** How long the REST hang-up gets before we also end the call's audio stream. */
const REST_HANGUP_GRACE_MS = 3_000;
/** End the call if nobody has spoken for this long. */
const IDLE_HANGUP_MS = 45_000;
/** Calls placed for a task often wait on hold or while someone checks something. */
const TASK_IDLE_HANGUP_MS = 3 * 60_000;

/**
 * GPT-Live sessions started while Twilio plays the greeting, keyed by the
 * call's stream token, so the model is ready the moment the greeting ends.
 */
const prewarmed = new Map<string, LiveCall>();

export function prewarmLiveCall(token: string, session: RelaySession): void {
  const call = new LiveCall(session);
  prewarmed.set(token, call);
  call.start().catch((err) => console.error("GPT-Live prewarm failed", err));
  setTimeout(() => {
    if (prewarmed.get(token) !== call) return;
    prewarmed.delete(token);
    call.abandon();
  }, PREWARM_TTL_MS).unref();
}

/** Drop a prewarmed session for a call that ended before its audio stream started. */
export function dropPrewarmedCall(conversationId: number): void {
  for (const [token, call] of prewarmed) {
    if (call.conversationId !== conversationId) continue;
    prewarmed.delete(token);
    call.abandon();
  }
}

export function handleStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  streamServer.handleUpgrade(req, socket, head, (ws) => {
    // Until Twilio's "start" message proves which call this is, nothing else is accepted.
    const timer = setTimeout(() => ws.close(), START_TIMEOUT_MS);
    const onFirst = (data: unknown) => {
      const msg = JSON.parse(String(data)) as TwilioStreamMessage;
      if (msg.event === "connected") return;
      ws.off("message", onFirst);
      clearTimeout(timer);
      const token = msg.start?.customParameters?.token ?? "";
      const session = msg.event === "start" ? takeRelaySession(token) : undefined;
      if (!session) {
        console.warn("Media stream with an invalid or expired token; closing");
        ws.close();
        return;
      }
      let call = prewarmed.get(token);
      prewarmed.delete(token);
      if (!call) {
        call = new LiveCall(session);
        call.start().catch((err) => console.error("GPT-Live start failed", err));
      }
      call.attach(ws, msg.start!).catch((err) => console.error("Attaching call stream failed", err));
    };
    ws.on("message", onFirst);
  });
}

interface TwilioStreamMessage {
  event: "connected" | "start" | "media" | "dtmf" | "mark" | "stop";
  streamSid?: string;
  start?: { streamSid: string; callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string; track?: string };
  dtmf?: { digit: string };
  mark?: { name: string };
}

class LiveCall {
  private twilio?: WebSocket;
  private user?: User;
  private ready: Promise<void> = Promise.resolve();
  private streamSid = "";
  private callSid = "";
  private live?: LiveWS;
  private liveReady = false;
  /** Prompt that makes GPT-Live speak first once the greeting ends; empty when not needed or sent. */
  private kickoff = "";
  private pendingAudio: string[] = [];
  private grouper = new TranscriptGrouper();
  private transcriptDone = false;
  /** Spoken lines and backend results, in order, for the agent backend. */
  private transcript: Array<{ id: string; speaker: string; text: string }> = [];
  private backendTools: AgentTool[] = [];
  private backendSystem = "";
  private backendDetails = "";
  private backendPreamble: ContentPart[] = [];
  private delegations: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private endRequested = false;
  private hangingUp = false;
  /** A hang-up was asked for before Twilio's audio stream arrived. */
  private hangUpWhenAttached = false;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private lastOutputAt = 0;
  private lastActivityAt = Date.now();
  private finishing = false;
  /** Hangs up after a goodbye, even if GPT-Live never delegates "hang up". */
  private goodbye: GoodbyeWatcher;
  /** Hold music or someone talking on the other end keeps the idle hang-up away. */
  private lineSound = new LineSound();
  private lastLineSoundAt = 0;
  /** Tasks the agent backend is working on for the call, and when the current one started. */
  private delegationsInFlight = 0;
  private delegationStartedAt = 0;

  constructor(private session: RelaySession) {
    this.goodbye = new GoodbyeWatcher({ handoffs: session.mode === "task" });
    this.grouper.on("segment.updated", (s) => this.upsertSegment(s));
    this.grouper.on("segment.closed", ({ segment }) => this.saveSegment(segment));
    // The greeting is played by Twilio's <Say> before the audio stream starts.
    this.transcript.push({ id: "greeting", speaker: "Assistant", text: session.greeting });
  }

  get conversationId(): number {
    return this.session.conversationId;
  }

  /** Load context and open the GPT-Live session; safe to run before the call's audio arrives. */
  start(): Promise<void> {
    this.ready = (async () => {
      this.user = (await getUser(this.session.userId))!;
      await this.prepareBackend();
      this.connectLive(await this.liveSessionConfig());
    })();
    return this.ready;
  }

  /** The call ended before its audio stream ever started. */
  abandon(): void {
    this.closed = true;
    this.abort.abort();
    try {
      this.live?.close({ code: 1000, reason: "call not connected" });
    } catch {
      // already closed
    }
  }

  private controls: CallControls = {
    endCall: () => {
      this.endRequested = true;
    },
    pressDigits: (digits) => {
      this.lastActivityAt = Date.now();
      this.playToCaller(dtmfAudio(digits));
    },
  };

  private fail(context: string, err: unknown): void {
    console.error(context, err);
  }

  // ---- Twilio side --------------------------------------------------------

  /** Connect the call's Twilio audio stream to this (possibly already running) session. */
  async attach(ws: WebSocket, start: NonNullable<TwilioStreamMessage["start"]>): Promise<void> {
    this.twilio = ws;
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    ws.on("message", (data) => this.onTwilio(data.toString()).catch((err) => this.fail("Twilio message error", err)));
    ws.on("close", () => this.shutdown());
    ws.on("error", (err) => console.error("Twilio stream socket error", err));
    this.lastActivityAt = Date.now();
    // Started before anything that could fail, so a call can always end itself.
    this.timers.push(
      setInterval(() => this.checkGoodbye(), 250),
      setInterval(() => {
        // Sound on the line with no words (hold music, a TV) stretches a user call's idle limit, but not forever.
        const lineBusy = Date.now() - this.lastLineSoundAt < 5000;
        const idleLimit = this.session.mode === "task" || lineBusy ? TASK_IDLE_HANGUP_MS : IDLE_HANGUP_MS;
        if (Date.now() - this.lastActivityAt < idleLimit || this.finishing || this.busyWithRequest()) return;
        this.instruct("Nobody has said anything for a while. Say a brief goodbye.");
        this.finishAfterSpeech(true, MAX_ASKED_GOODBYE_MS);
      }, 5000),
    );
    if (this.hangUpWhenAttached) this.hangUp();

    const s = this.session;
    let maxCallMinutes = config.agent.maxCallMinutes;
    try {
      const inbound = await query<{ direction: string }>(
        "UPDATE conversations SET call_sid = COALESCE(call_sid, $2), call_status = 'in-progress' WHERE id = $1 RETURNING direction",
        [s.conversationId, start.callSid],
      );
      // Outbound calls are recorded from answer via calls.create; inbound ones start here.
      if (inbound[0]?.direction === "inbound") {
        twilioClient
          .calls(start.callSid)
          .recordings.create({
            recordingStatusCallback: `${config.publicBaseUrl}/twilio/voice/recording`,
            recordingStatusCallbackEvent: ["completed"],
          })
          .catch((err) => console.error("Could not start call recording", err));
      }
      await addMessage(s.conversationId, "assistant", s.greeting);
      maxCallMinutes = (await getSettings()).maxCallMinutes;
    } catch (err) {
      this.fail("Call setup bookkeeping failed", err);
    }
    this.timers.push(
      setTimeout(() => {
        this.instruct("The call has reached its time limit. Tell the other person you have to go and say goodbye now, briefly.");
        this.finishAfterSpeech(true, MAX_ASKED_GOODBYE_MS);
      }, maxCallMinutes * 60 * 1000),
    );
    await this.ready;
    this.maybeKickoff();
  }

  /**
   * On calls the agent placed, GPT-Live starts talking the moment the greeting
   * ends (when the audio stream attaches) instead of waiting for "hello?".
   */
  private maybeKickoff(): void {
    if (!this.kickoff || !this.liveReady || !this.twilio) return;
    const content = this.kickoff;
    this.kickoff = "";
    this.live!.send({ type: "session.commentary.append", content, delegation_id: null });
  }

  private async onTwilio(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as TwilioStreamMessage;
    switch (msg.event) {
      case "media":
        if (msg.media?.track === "outbound" || this.hangingUp) return;
        if (this.lineSound.frame(Buffer.from(msg.media!.payload, "base64"))) {
          this.lastLineSoundAt = Date.now();
          // On calls placed for a task, hold music can go on for a while; the call's time limit still applies.
          if (this.session.mode === "task") this.lastActivityAt = this.lastLineSoundAt;
        }
        if (this.liveReady) this.live!.send({ type: "session.input_audio.append", audio: msg.media!.payload });
        else if (this.pendingAudio.length < MAX_PENDING_FRAMES) this.pendingAudio.push(msg.media!.payload);
        break;
      case "mark":
        // Twilio echoes a mark once all audio sent before it has played.
        if (msg.mark?.name === "hangup") this.hangUp();
        break;
      case "dtmf":
        await addMessage(this.session.conversationId, "event", `Caller pressed ${msg.dtmf?.digit}`);
        break;
      case "stop":
        this.twilio?.close();
        break;
    }
  }

  private playToCaller(audio: Buffer): void {
    // 20 ms frames, as Twilio sends them.
    for (let i = 0; i < audio.length; i += 160) this.sendTwilio({ event: "media", media: { payload: audio.subarray(i, i + 160).toString("base64") } });
  }

  private sendTwilio(payload: Record<string, unknown>): void {
    if (this.twilio?.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({ ...payload, streamSid: this.streamSid }));
  }

  // ---- GPT-Live side ------------------------------------------------------

  private async liveSessionConfig(): Promise<SessionConfig> {
    const s = this.session;
    let instructions: string;
    if (s.mode === "user") {
      instructions = liveUserInstructions(await userDetails(this.user!));
    } else {
      const task = (await getTask(s.taskId))!;
      instructions = liveTaskInstructions(taskBrief(task, this.user!));
      if (s.speakFirst) {
        instructions += `\n\n${LIVE_SPEAK_FIRST}`;
        this.kickoff = `The greeting has just finished playing. Without waiting for a reply, continue now: briefly say why you're calling (${task.objective}) and ask your first question.`;
      }
    }
    return {
      model: config.openai.liveModel,
      instructions,
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.openai.liveVoice } },
      delegation: { type: "client" },
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: s.mode === "task" && s.speakFirst
                ? "The call was answered and this greeting, including the recording disclosure, was just played. Continue speaking immediately after it."
                : "The call has connected. This greeting, including the recording disclosure, was already played:",
            },
          ],
        },
        { role: "assistant", content: [{ type: "output_text", text: s.greeting }] },
      ],
    };
  }

  private connectLive(sessionConfig: SessionConfig): void {
    const live = new LiveWS(openai!);
    this.live = live;
    live.on("error", (err) => console.error("GPT-Live error", err.error ?? err.message));
    live.on("close", (code, reason) => {
      if (!this.closed) {
        console.warn(`GPT-Live socket closed (${code} ${reason}); hanging up`);
        this.hangUp();
      }
    });
    live.on("event", (event) => this.onLive(event));
    live.send({ type: "session.start", session: sessionConfig });
  }

  private onLive(event: ServerEvent): void {
    switch (event.type) {
      case "session.started":
        this.liveReady = true;
        for (const audio of this.pendingAudio.splice(0)) this.live!.send({ type: "session.input_audio.append", audio });
        this.maybeKickoff();
        break;
      case "session.output_audio.delta":
        // Before the stream attaches, the greeting is still playing; drop anything early.
        if (!this.twilio) return;
        // GPT-Live can stream silence between turns; only audible audio counts as the agent talking.
        if (isAudibleMulaw(Buffer.from(event.delta, "base64"))) {
          this.lastOutputAt = this.lastActivityAt = Date.now();
          this.goodbye.agentAudio(this.lastOutputAt);
        }
        this.sendTwilio({ event: "media", media: { payload: event.delta } });
        break;
      case "session.input_transcript.delta":
        if (hasWords(event.delta)) this.lastActivityAt = Date.now();
        if (this.twilio) this.goodbye.callerSaid(event.delta, Date.now());
        if (!this.transcriptDone) this.grouper.push(event);
        break;
      case "session.output_transcript.delta":
        if (event.delta.trim()) this.lastActivityAt = Date.now();
        if (this.twilio) this.goodbye.agentSaid(event.delta, Date.now());
        if (!this.transcriptDone) this.grouper.push(event);
        break;
      case "session.delegation.created":
        this.queueDelegation(event.delegation.id);
        break;
      case "session.closed":
        this.closeTranscript();
        if (!this.hangingUp && event.reason !== "close_requested") {
          console.warn(`GPT-Live session closed: ${event.reason}`);
          this.hangUp();
        }
        break;
    }
  }

  private instruct(content: string): void {
    if (this.liveReady) this.live!.send({ type: "session.instructions.append", content, delegation_id: null });
  }

  // ---- Transcript ---------------------------------------------------------

  /** Flush the last segments; the grouper rejects events after this. */
  private closeTranscript(): void {
    if (this.transcriptDone) return;
    this.transcriptDone = true;
    this.grouper.close();
  }

  private speakerLabel(speaker: "user" | "assistant"): string {
    if (speaker === "assistant") return "Assistant";
    return this.session.mode === "user" ? "User" : "Other party";
  }

  private upsertSegment(segment: TranscriptSegment): void {
    const line = { id: segment.id, speaker: this.speakerLabel(segment.speaker), text: segment.text };
    const existing = this.transcript.find((l) => l.id === segment.id);
    if (existing) existing.text = segment.text;
    else this.transcript.push(line);
  }

  private checkGoodbye(): void {
    if (this.finishing) return;
    // "Okay, I'll take care of it" while the backend works must never cancel the errand.
    if (this.busyWithRequest()) return;
    if (!this.goodbye.isOver(Date.now())) return;
    const who = this.goodbye.endedBy === "agent" ? "Agent" : "The other side";
    console.log(`Call ${this.callSid}: ${who.toLowerCase()} said goodbye; hanging up`);
    addMessage(this.session.conversationId, "event", `${who} said goodbye; hanging up`).catch((err) => this.fail("Saving event failed", err));
    this.finishAfterSpeech(false, MAX_AFTER_GOODBYE_MS);
  }

  private saveSegment(segment: TranscriptSegment): void {
    this.upsertSegment(segment);
    if (!segment.text.trim()) return;
    const role = segment.speaker === "assistant" ? "assistant" : this.session.mode === "user" ? "user" : "counterpart";
    addMessage(this.session.conversationId, role, segment.text.trim()).catch((err) => this.fail("Saving transcript failed", err));
  }

  // ---- Delegations, handled by the agent model --------------------------------------

  private async prepareBackend(): Promise<void> {
    const s = this.session;
    if (s.mode === "user") {
      this.backendSystem = `${USER_ASSISTANT_PROMPT}\n\n${LIVE_BACKEND_ADDENDUM}`;
      this.backendDetails = await userDetails(this.user!);
      this.backendTools = userTools(this.user!, s.conversationId, this.controls);
      this.backendPreamble = await recentChatContext(this.user!);
    } else {
      const task = (await getTask(s.taskId))!;
      this.backendSystem = `${taskCallPrompt()}\n\n${LIVE_BACKEND_ADDENDUM}`;
      this.backendDetails = taskBrief(task, this.user!);
      this.backendTools = taskCallTools(this.controls);
    }
  }

  /** The agent backend is working on something for the caller (and hasn't been at it for too long). */
  private busyWithRequest(): boolean {
    return this.delegationsInFlight > 0 && Date.now() - this.delegationStartedAt < DELEGATION_HOLD_MAX_MS;
  }

  private queueDelegation(delegationId: string): void {
    if (this.delegationsInFlight++ === 0) this.delegationStartedAt = Date.now();
    // One at a time, so results land in the transcript in order.
    this.delegations = this.delegations
      .then(() => this.runDelegation(delegationId))
      .catch((err) => this.fail("Delegation failed", err))
      .finally(() => {
        this.delegationsInFlight--;
        this.delegationStartedAt = this.lastActivityAt = Date.now();
        // Give the agent time to relay the result before a pending goodbye ends the call.
        this.goodbye.extend(Date.now());
      });
  }

  private async runDelegation(delegationId: string): Promise<void> {
    if (this.closed) return;
    const s = this.session;
    const transcript = this.transcript.map((l) => `${l.speaker}: ${l.text}`).join("\n");
    const content: ContentPart[] = [
      ...this.backendPreamble,
      { type: "input_text", text: `[Call transcript so far:]\n${transcript}\n\n[The voice model just delegated a task based on the end of this conversation. Handle it.]` },
    ];

    let result: string;
    try {
      const run = await runAgent({
        system: this.backendSystem,
        systemDetails: this.backendDetails,
        messages: [{ role: "user", content }],
        tools: this.backendTools,
        effort: "low",
        maxTokens: 4000,
        signal: this.abort.signal,
      });
      result = run.text || "Done.";
      if (run.toolCalls.length) await addMessage(s.conversationId, "event", `Backend ran ${run.toolCalls.join(", ")}`);
    } catch (err) {
      if (this.closed) return;
      this.fail("Agent backend failed", err);
      result = "That didn't work because of a technical problem. Apologize and offer to try again or follow up by text.";
    }

    if (this.endRequested) {
      // The goodbye has been said; end silently once it finishes playing.
      this.transcript.push({ id: `delegation-${delegationId}`, speaker: "Backend result", text: "Ending the call." });
      if (this.liveReady) {
        this.live!.send({
          type: "session.thinking.append",
          content: "The call is being ended now. Do not say anything else.",
          delegation_id: delegationId,
        });
      }
      await addMessage(s.conversationId, "event", "Agent ended the call");
      this.finishAfterSpeech(false, MAX_GOODBYE_MS);
      return;
    }
    this.transcript.push({ id: `delegation-${delegationId}`, speaker: "Backend result", text: result });
    if (this.liveReady) {
      this.live!.send({ type: "session.commentary.append", content: result.slice(0, 1500), delegation_id: delegationId });
    }
  }

  // ---- Teardown -----------------------------------------------------------

  /**
   * Hang up once the agent has finished talking: wait until its audible audio
   * has stopped briefly, then send Twilio a mark, which comes back when
   * everything queued before it has actually played to the caller.
   * `expectGoodbye`: GPT-Live has just been asked to say goodbye, so wait for
   * it to say one (it may be mid-sentence first), or for it to go quiet for
   * SILENT_GOODBYE_MS without one. `maxMs`: hang up regardless after this long.
   */
  private finishAfterSpeech(expectGoodbye: boolean, maxMs: number): void {
    if (this.finishing) return;
    this.finishing = true;
    const startedAt = Date.now();
    const poll = setInterval(() => {
      const now = Date.now();
      const settled = now - this.lastOutputAt >= SPEECH_SETTLE_MS;
      const ready = expectGoodbye
        ? (this.goodbye.agentSaidGoodbyeSince(startedAt) && settled) || now - Math.max(startedAt, this.lastOutputAt) >= SILENT_GOODBYE_MS
        : settled;
      if (now - startedAt >= maxMs) {
        clearInterval(poll);
        this.hangUp();
      } else if (ready) {
        clearInterval(poll);
        this.sendTwilio({ event: "mark", mark: { name: "hangup" } });
        // If the mark never comes back, still hang up.
        this.timers.push(setTimeout(() => this.hangUp(), MARK_TIMEOUT_MS));
      }
    }, 100);
    this.timers.push(poll);
  }

  /**
   * End the call: through Twilio's REST API, and if that fails or is slow, by
   * closing the media stream, which ends <Connect> so Twilio fetches its action
   * URL (/twilio/voice/relay-ended answers <Hangup/>).
   */
  private hangUp(): void {
    if (this.hangingUp) return;
    const ws = this.twilio;
    if (!ws) {
      // Too early to hang up the call; do it once its audio stream arrives.
      this.hangUpWhenAttached = true;
      return;
    }
    this.hangingUp = true;
    console.log(`Call ${this.callSid}: hanging up`);
    if (this.liveReady) this.live!.send({ type: "session.close" });
    const endStream = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.close(1000, "call ended");
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, 3000).unref();
    };
    const fallback = setTimeout(endStream, REST_HANGUP_GRACE_MS);
    fallback.unref();
    if (!this.callSid) return void endStream();
    twilioClient
      .calls(this.callSid)
      .update({ status: "completed" })
      .catch((err) => {
        clearTimeout(fallback);
        if (ws.readyState !== WebSocket.OPEN) return; // the call ended anyway
        this.fail("Hangup failed", err);
        addMessage(this.session.conversationId, "event", `Twilio hang-up request failed (${(err as Error).message}); ending the call's audio stream instead`).catch(
          () => undefined,
        );
        endStream();
      });
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const t of this.timers) clearTimeout(t);
    this.closeTranscript();
    try {
      this.live?.close({ code: 1000, reason: "call ended" });
    } catch {
      // already closed
    }
    const conversationId = this.session.conversationId;
    // Let the transcript writes from grouper.close() land before summarizing.
    setTimeout(() => finalizeCall(conversationId).catch((err) => this.fail("Call finalize failed", err)), 1000);
  }
}
