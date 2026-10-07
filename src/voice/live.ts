import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import OpenAI from "openai";
import { TranscriptGrouper, type TranscriptSegment } from "openai/lib/live/transcript-grouper";
import type { ServerEvent, SessionConfig } from "openai/resources/live/live";
import { LiveWS } from "openai/resources/live/ws";
import { WebSocket, WebSocketServer } from "ws";
import { runAgent, type AgentTool } from "../agent/claude.js";
import { recentChatContext, taskBrief, userDetails } from "../agent/context.js";
import {
  LIVE_BACKEND_ADDENDUM,
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
import { finalizeCall } from "./summary.js";

/**
 * GPT-Live voice calls. Twilio Media Streams sends the caller's 8 kHz μ-law
 * audio here; we forward it to a GPT-Live session in the same format and play
 * its speech back. GPT-Live handles the conversation itself and delegates
 * tasks (placing calls, pressing keys, hanging up) to us, which Claude
 * carries out with the same tools the chat agent uses.
 */
export const streamServer = new WebSocketServer({ noServer: true });
const openai = config.voice.engine === "gpt-live" ? new OpenAI() : undefined;

export function handleStreamUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  streamServer.handleUpgrade(req, socket, head, (ws) => new LiveCall(ws));
}

/** Twilio sends 20 ms frames; buffer about 3 s of audio while GPT-Live starts. */
const MAX_PENDING_FRAMES = 150;
/** Twilio must identify the call (with our token) promptly or we drop it. */
const START_TIMEOUT_MS = 10_000;
/** Time to let a goodbye play before hanging up. */
const HANGUP_DELAY_MS = 6_000;

interface TwilioStreamMessage {
  event: "connected" | "start" | "media" | "dtmf" | "mark" | "stop";
  streamSid?: string;
  start?: { streamSid: string; callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string; track?: string };
  dtmf?: { digit: string };
}

class LiveCall {
  private session?: RelaySession;
  private user?: User;
  private streamSid = "";
  private callSid = "";
  private live?: LiveWS;
  private liveReady = false;
  private pendingAudio: string[] = [];
  private grouper = new TranscriptGrouper();
  private transcriptDone = false;
  /** Spoken lines and backend results, in order, for the Claude backend. */
  private transcript: Array<{ id: string; speaker: string; text: string }> = [];
  private backendTools: AgentTool[] = [];
  private backendSystem = "";
  private backendDetails = "";
  private backendPreamble: BetaContentBlockParam[] = [];
  private delegations: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private endRequested = false;
  private hangingUp = false;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private twilio: WebSocket) {
    twilio.on("message", (data) => this.onTwilio(data.toString()).catch((err) => this.fail("Twilio message error", err)));
    twilio.on("close", () => this.shutdown());
    twilio.on("error", (err) => console.error("Twilio stream socket error", err));
    this.timers.push(setTimeout(() => !this.session && twilio.close(), START_TIMEOUT_MS));
    this.grouper.on("segment.updated", (s) => this.upsertSegment(s));
    this.grouper.on("segment.closed", ({ segment }) => this.saveSegment(segment));
  }

  private controls: CallControls = {
    endCall: () => {
      this.endRequested = true;
    },
    pressDigits: (digits) => this.playToCaller(dtmfAudio(digits)),
  };

  private fail(context: string, err: unknown): void {
    console.error(context, err);
  }

  // ---- Twilio side --------------------------------------------------------

  private async onTwilio(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as TwilioStreamMessage;
    switch (msg.event) {
      case "start":
        await this.onStart(msg.start!);
        break;
      case "media":
        if (!this.session || msg.media?.track === "outbound") return;
        if (this.liveReady) this.live!.send({ type: "session.input_audio.append", audio: msg.media!.payload });
        else if (this.pendingAudio.length < MAX_PENDING_FRAMES) this.pendingAudio.push(msg.media!.payload);
        break;
      case "dtmf":
        if (this.session) await addMessage(this.session.conversationId, "event", `Caller pressed ${msg.dtmf?.digit}`);
        break;
      case "stop":
        this.twilio.close();
        break;
    }
  }

  private async onStart(start: NonNullable<TwilioStreamMessage["start"]>): Promise<void> {
    const session = takeRelaySession(start.customParameters?.token ?? "");
    if (!session) {
      console.warn("Media stream with an invalid or expired token; closing");
      this.twilio.close();
      return;
    }
    this.session = session;
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    this.user = (await getUser(session.userId))!;

    const inbound = await query<{ direction: string }>(
      "UPDATE conversations SET call_sid = COALESCE(call_sid, $2), call_status = 'in-progress' WHERE id = $1 RETURNING direction",
      [session.conversationId, start.callSid],
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
    // The disclosure greeting was played by <Say> before the stream started.
    await addMessage(session.conversationId, "assistant", session.greeting);
    this.transcript.push({ id: "greeting", speaker: "Assistant", text: session.greeting });

    this.timers.push(
      setTimeout(() => {
        this.instruct("The call has reached its time limit. Tell the other person you have to go and say goodbye now.");
        this.hangUp(HANGUP_DELAY_MS * 2);
      }, config.agent.maxCallMinutes * 60 * 1000),
    );

    await this.prepareBackend();
    this.connectLive(await this.liveSessionConfig());
  }

  private playToCaller(audio: Buffer): void {
    // 20 ms frames, as Twilio sends them.
    for (let i = 0; i < audio.length; i += 160) this.sendTwilio({ event: "media", media: { payload: audio.subarray(i, i + 160).toString("base64") } });
  }

  private sendTwilio(payload: Record<string, unknown>): void {
    if (this.twilio.readyState === WebSocket.OPEN) this.twilio.send(JSON.stringify({ ...payload, streamSid: this.streamSid }));
  }

  // ---- GPT-Live side ------------------------------------------------------

  private async liveSessionConfig(): Promise<SessionConfig> {
    const s = this.session!;
    let instructions: string;
    if (s.mode === "user") {
      instructions = liveUserInstructions(await userDetails(this.user!));
    } else {
      const task = (await getTask(s.taskId))!;
      instructions = liveTaskInstructions(taskBrief(task, this.user!));
    }
    return {
      model: config.openai.liveModel,
      instructions,
      audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: config.openai.liveVoice } },
      delegation: { type: "client" },
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: "The call has connected. This greeting, including the recording disclosure, was already played:" }],
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
        this.hangUp(0);
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
        break;
      case "session.output_audio.delta":
        this.sendTwilio({ event: "media", media: { payload: event.delta } });
        break;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta":
        if (!this.transcriptDone) this.grouper.push(event);
        break;
      case "session.delegation.created":
        this.queueDelegation(event.delegation.id);
        break;
      case "session.closed":
        this.closeTranscript();
        if (!this.hangingUp && event.reason !== "close_requested") {
          console.warn(`GPT-Live session closed: ${event.reason}`);
          this.hangUp(0);
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
    return this.session?.mode === "user" ? "User" : "Other party";
  }

  private upsertSegment(segment: TranscriptSegment): void {
    const line = { id: segment.id, speaker: this.speakerLabel(segment.speaker), text: segment.text };
    const existing = this.transcript.find((l) => l.id === segment.id);
    if (existing) existing.text = segment.text;
    else this.transcript.push(line);
  }

  private saveSegment(segment: TranscriptSegment): void {
    this.upsertSegment(segment);
    if (!this.session || !segment.text.trim()) return;
    const role = segment.speaker === "assistant" ? "assistant" : this.session.mode === "user" ? "user" : "counterpart";
    addMessage(this.session.conversationId, role, segment.text.trim()).catch((err) => this.fail("Saving transcript failed", err));
  }

  // ---- Delegations, handled by Claude --------------------------------------

  private async prepareBackend(): Promise<void> {
    const s = this.session!;
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

  private queueDelegation(delegationId: string): void {
    // One at a time, so results land in the transcript in order.
    this.delegations = this.delegations.then(() => this.runDelegation(delegationId)).catch((err) => this.fail("Delegation failed", err));
  }

  private async runDelegation(delegationId: string): Promise<void> {
    if (this.closed) return;
    const s = this.session!;
    const transcript = this.transcript.map((l) => `${l.speaker}: ${l.text}`).join("\n");
    const content: BetaContentBlockParam[] = [
      ...this.backendPreamble,
      { type: "text", text: `[Call transcript so far:]\n${transcript}\n\n[The voice model just delegated a task based on the end of this conversation. Handle it.]` },
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
      this.fail("Claude backend failed", err);
      result = "That didn't work because of a technical problem. Apologize and offer to try again or follow up by text.";
    }

    if (this.endRequested) {
      result = "The call is ending now. Say a brief goodbye.";
      this.hangUp(HANGUP_DELAY_MS);
    }
    this.transcript.push({ id: `delegation-${delegationId}`, speaker: "Backend result", text: result });
    if (this.liveReady) {
      this.live!.send({ type: "session.commentary.append", content: result.slice(0, 1500), delegation_id: delegationId });
    }
  }

  // ---- Teardown -----------------------------------------------------------

  private hangUp(delayMs: number): void {
    if (this.hangingUp) return;
    this.hangingUp = true;
    this.timers.push(
      setTimeout(() => {
        if (this.liveReady) this.live!.send({ type: "session.close" });
        if (this.callSid) {
          twilioClient
            .calls(this.callSid)
            .update({ status: "completed" })
            .catch((err) => this.fail("Hangup failed", err));
        }
      }, delayMs),
    );
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
    if (this.session) {
      const conversationId = this.session.conversationId;
      // Let the transcript writes from grouper.close() land before summarizing.
      setTimeout(() => finalizeCall(conversationId).catch((err) => this.fail("Call finalize failed", err)), 1000);
    }
  }
}
