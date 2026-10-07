import type { IncomingMessage } from "node:http";
import { APIUserAbortError } from "openai";
import { WebSocket, WebSocketServer } from "ws";
import { runAgent, type AgentTool, type InputItem } from "../agent/llm.js";
import { recentChatContext, taskBrief, userDetails } from "../agent/context.js";
import { taskCallPrompt, USER_ASSISTANT_PROMPT, USER_VOICE_ADDENDUM } from "../agent/prompts.js";
import { taskCallTools, userTools, type CallControls } from "../agent/tools.js";
import { config } from "../config.js";
import { addMessage, getTask, getUser, query, type User } from "../db/index.js";
import { twilioClient } from "../twilio.js";
import { takeRelaySession, type RelaySession } from "./sessions.js";
import { finalizeCall } from "./summary.js";
import { getSettings } from "../settings.js";

export const relayServer = new WebSocketServer({ noServer: true });

export function handleRelayUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const session = url.pathname === "/twilio/relay" ? takeRelaySession(url.searchParams.get("token") ?? "") : undefined;
  if (!session) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  relayServer.handleUpgrade(req, socket, head, (ws) => new RelayCall(ws, session));
}

/** Rough speaking rate used to let the goodbye finish before hanging up. */
const CHARS_PER_SECOND = 14;

class RelayCall {
  private messages: InputItem[] = [];
  private system = "";
  private systemDetails = "";
  private tools: AgentTool[] = [];
  private pending: string[] = [];
  private running = false;
  private abort?: AbortController;
  private spoken = "";
  private endRequested = false;
  private closed = false;
  private hardLimit?: NodeJS.Timeout;
  private ready: Promise<void>;

  constructor(private ws: WebSocket, private session: RelaySession) {
    ws.on("message", (data) => this.onMessage(data.toString()).catch((err) => console.error("Relay message error", err)));
    ws.on("close", () => this.onClose());
    ws.on("error", (err) => console.error("Relay socket error", err));
    this.ready = this.init();
  }

  private controls: CallControls = {
    endCall: () => {
      this.endRequested = true;
    },
    pressDigits: (digits) => this.send({ type: "sendDigits", digits }),
  };

  private async init(): Promise<void> {
    const s = this.session;
    const user = (await getUser(s.userId)) as User;
    if (s.mode === "user") {
      this.system = `${USER_ASSISTANT_PROMPT}\n\n${USER_VOICE_ADDENDUM}`;
      this.systemDetails = await userDetails(user);
      this.tools = userTools(user, s.conversationId, this.controls);
      this.messages.push({ role: "user", content: await recentChatContext(user) });
    } else {
      const task = await getTask(s.taskId);
      if (!task) throw new Error(`Task ${s.taskId} missing`);
      this.system = taskCallPrompt();
      this.systemDetails = taskBrief(task, user);
      this.tools = taskCallTools(this.controls);
      this.messages.push({ role: "user", content: "[The call has connected.]" });
    }
    this.messages.push({ role: "assistant", content: s.greeting });
    await addMessage(s.conversationId, "assistant", s.greeting);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private async onMessage(raw: string): Promise<void> {
    const msg = JSON.parse(raw) as { type: string; [k: string]: any };
    await this.ready;
    switch (msg.type) {
      case "setup":
        await this.onSetup(msg.callSid as string);
        break;
      case "prompt":
        if (!msg.voicePrompt?.trim()) return;
        await addMessage(this.session.conversationId, this.session.mode === "user" ? "user" : "counterpart", msg.voicePrompt);
        this.pending.push(msg.voicePrompt);
        this.abort?.abort();
        void this.process();
        break;
      case "interrupt":
        this.abort?.abort();
        break;
      case "dtmf":
        await addMessage(this.session.conversationId, "event", `Caller pressed ${msg.digit}`);
        break;
      case "error":
        console.error("ConversationRelay error", msg.description);
        break;
    }
  }

  private async onSetup(callSid: string): Promise<void> {
    await query("UPDATE conversations SET call_sid = COALESCE(call_sid, $2), call_status = 'in-progress' WHERE id = $1", [
      this.session.conversationId,
      callSid,
    ]);
    // Outbound calls are recorded from answer via calls.create; inbound ones start here.
    if (this.session.mode === "user" || (await this.isInbound())) {
      try {
        await twilioClient.calls(callSid).recordings.create({
          recordingStatusCallback: `${config.publicBaseUrl}/twilio/voice/recording`,
          recordingStatusCallbackEvent: ["completed"],
        });
      } catch (err) {
        console.error("Could not start call recording", err);
      }
    }
    const limitMs = (await getSettings()).maxCallMinutes * 60 * 1000;
    this.hardLimit = setTimeout(() => {
      this.send({ type: "text", token: "I'm sorry, we've reached the time limit for this call. Goodbye.", last: true });
      setTimeout(() => this.send({ type: "end" }), 6000);
    }, limitMs);
  }

  private async isInbound(): Promise<boolean> {
    const rows = await query<{ direction: string }>("SELECT direction FROM conversations WHERE id = $1", [this.session.conversationId]);
    return rows[0]?.direction === "inbound";
  }

  /** Drain queued caller speech, one agent run at a time. */
  private async process(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && !this.closed) {
        const text = this.pending.splice(0).join(" ");
        this.appendUser(text);
        this.abort = new AbortController();
        this.spoken = "";
        try {
          const result = await runAgent({
            system: this.system,
            systemDetails: this.systemDetails,
            messages: this.messages,
            tools: this.tools,
            effort: "low",
            maxTokens: 4000,
            signal: this.abort.signal,
            onText: (delta) => {
              this.spoken += delta;
              this.send({ type: "text", token: delta, last: false });
            },
            onToolStart: () => this.send({ type: "text", token: " ", last: true }),
          });
          this.send({ type: "text", token: "", last: true });
          if (result.text) await addMessage(this.session.conversationId, "assistant", result.text);
          if (this.endRequested) this.hangUpAfterSpeech(result.text);
        } catch (err) {
          if (!(err instanceof APIUserAbortError)) {
            console.error("Voice agent failed", err);
            this.send({ type: "text", token: "Sorry, I'm having trouble on my end. Could you say that again?", last: true });
            continue;
          }
          // Interrupted mid-answer: keep what was actually said so the model knows.
          if (this.spoken.trim()) {
            const said = `${this.spoken.trim()} [interrupted]`;
            this.appendAssistant(said);
            await addMessage(this.session.conversationId, "assistant", said);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private appendUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  /** Record what was actually said before an interruption, unless the turn already landed. */
  private appendAssistant(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && "role" in last && last.role === "user") this.messages.push({ role: "assistant", content: text });
  }

  private hangUpAfterSpeech(lastText: string): void {
    const delay = Math.min(12_000, (lastText.length / CHARS_PER_SECOND) * 1000 + 1500);
    setTimeout(() => this.send({ type: "end" }), delay);
  }

  private onClose(): void {
    this.closed = true;
    this.abort?.abort();
    if (this.hardLimit) clearTimeout(this.hardLimit);
    finalizeCall(this.session.conversationId).catch((err) => console.error("Call finalize failed", err));
  }
}
