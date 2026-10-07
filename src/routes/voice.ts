import express from "express";
import { config } from "../config.js";
import {
  addMessage,
  createConversation,
  findActiveUserByPhone,
  getUser,
  isBlocked,
  query,
  queryOne,
  type Conversation,
} from "../db/index.js";
import { toE164 } from "../phone.js";
import { finishTask } from "../tasks.js";
import { requireTwilioSignature } from "../twilio.js";
import { createRelaySession } from "../voice/sessions.js";
import { finalizeCall } from "../voice/summary.js";
import { buildRelayTwiml, sayAndHangup } from "../voice/twiml.js";
import { latestTaskForNumber } from "./sms.js";

export const voiceRouter = express.Router();

/** Inbound call to our number. */
voiceRouter.post("/twilio/voice", requireTwilioSignature, async (req, res) => {
  const from = toE164(req.body.From ?? "") ?? String(req.body.From ?? "");
  const callSid = String(req.body.CallSid);
  try {
    res.type("text/xml").send(await inboundCallTwiml(from, callSid));
  } catch (err) {
    console.error("Inbound call setup failed", err);
    res.type("text/xml").send(sayAndHangup("Sorry, something went wrong. Please try again later."));
  }
});

async function inboundCallTwiml(from: string, callSid: string): Promise<string> {
  const user = await findActiveUserByPhone(from);
  if (user) {
    const conversation = await createConversation({ kind: "user_call", userId: user.id, counterpartPhone: from, direction: "inbound", callSid });
    const greeting = `Hi ${user.name.split(" ")[0]}, it's ${config.agent.name}. Just so you know, this call is recorded and transcribed. What can I do for you?`;
    const token = createRelaySession({ mode: "user", conversationId: conversation.id, userId: user.id, greeting });
    return buildRelayTwiml(token, greeting);
  }

  // A third party calling back about something we contacted them about.
  const task = (await isBlocked(from)) ? undefined : await latestTaskForNumber(from);
  const requester = task && (await getUser(task.user_id));
  if (task && requester?.active) {
    const conversation = await createConversation({
      kind: "task_call",
      userId: requester.id,
      taskId: task.id,
      counterpartPhone: from,
      direction: "inbound",
      callSid,
    });
    await query("UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1", [task.id]);
    const greeting = `Hi, this is ${config.agent.name}, an AI assistant for ${requester.name}, following up on our earlier message. This call is recorded and transcribed. How can I help?`;
    const token = createRelaySession({ mode: "task", conversationId: conversation.id, taskId: task.id, userId: requester.id, greeting });
    return buildRelayTwiml(token, greeting);
  }

  const conversation = await createConversation({ kind: "unknown_call", counterpartPhone: from, direction: "inbound", callSid });
  await addMessage(conversation.id, "event", "Call from a number that is not invited; rejected");
  return sayAndHangup("Sorry, this number only takes calls from invited users. Goodbye.");
}

/** Called by <Connect action> when the ConversationRelay session ends. */
voiceRouter.post("/twilio/voice/relay-ended", requireTwilioSignature, (_req, res) => {
  res.type("text/xml").send("<Response><Hangup/></Response>");
});

const NOT_CONNECTED = new Set(["busy", "no-answer", "failed", "canceled"]);

voiceRouter.post("/twilio/voice/status", requireTwilioSignature, async (req, res) => {
  res.sendStatus(204);
  try {
    const status = String(req.body.CallStatus);
    const conversation = await queryOne<Conversation>(
      `UPDATE conversations SET call_status = $2,
         ended_at = CASE WHEN $3 THEN COALESCE(ended_at, now()) ELSE ended_at END
       WHERE call_sid = $1 RETURNING *`,
      [req.body.CallSid, status, status === "completed" || NOT_CONNECTED.has(status)],
    );
    if (!conversation) return;
    if (NOT_CONNECTED.has(status)) {
      await addMessage(conversation.id, "event", `Call ${status}`);
      if (conversation.task_id && conversation.direction === "outbound") {
        const reason = status === "no-answer" ? "nobody answered" : status === "busy" ? "the line was busy" : "the call could not be connected";
        await finishTask(conversation.task_id, "failed", `I couldn't reach them: ${reason}.`);
      }
    } else if (status === "completed") {
      await addMessage(conversation.id, "event", `Call ended (${req.body.CallDuration ?? "?"}s)`);
      // Normally finalized when the relay socket closes; this covers calls where it never opened.
      setTimeout(() => finalizeCall(conversation.id).catch((err) => console.error(err)), 15_000);
    }
  } catch (err) {
    console.error("Call status handling failed", err);
  }
});

voiceRouter.post("/twilio/voice/recording", requireTwilioSignature, async (req, res) => {
  res.sendStatus(204);
  await query("UPDATE conversations SET recording_sid = $2, recording_duration = $3 WHERE call_sid = $1", [
    req.body.CallSid,
    req.body.RecordingSid,
    Number(req.body.RecordingDuration ?? 0),
  ]).catch((err) => console.error("Recording callback failed", err));
});
