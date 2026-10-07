import express from "express";
import { config } from "../config.js";
import {
  addMessage,
  createConversation,
  findActiveUserByPhone,
  getTask,
  getUser,
  isBlocked,
  query,
  queryOne,
  type Conversation,
} from "../db/index.js";
import { toE164 } from "../phone.js";
import { callbackTaskForNumber } from "../numbers.js";
import { finishTask } from "../tasks.js";
import { requireTwilioSignature } from "../twilio.js";
import { connectCall } from "../voice/connect.js";
import { dropPrewarmedCall } from "../voice/live.js";
import { finalizeCall } from "../voice/summary.js";
import { sayAndHangup } from "../voice/twiml.js";
import { fillGreeting, getSettings } from "../settings.js";

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
  const settings = await getSettings();
  const user = await findActiveUserByPhone(from);
  if (user) {
    const conversation = await createConversation({ kind: "user_call", userId: user.id, counterpartPhone: from, direction: "inbound", callSid });
    if (!settings.callsEnabled) {
      await addMessage(conversation.id, "event", "Calls are turned off; call rejected");
      return sayAndHangup(`Sorry, ${config.agent.name} isn't taking calls right now. You can still use the web chat. Goodbye.`);
    }
    const greeting = fillGreeting(settings.greetingUserInbound, { agent: config.agent.name, caller: user.name.split(" ")[0] });
    return connectCall({ mode: "user", conversationId: conversation.id, userId: user.id, greeting });
  }

  // A third party calling back about something we contacted them about.
  // Only numbers that some user still allows to call back get through.
  const task = (await isBlocked(from)) ? undefined : await callbackTaskForNumber(from);
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
    if (!settings.callsEnabled) {
      await addMessage(conversation.id, "event", "Calls are turned off; call rejected");
      return sayAndHangup("Sorry, no one is available to take your call right now. Goodbye.");
    }
    await query("UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1", [task.id]);
    const greeting = fillGreeting(settings.greetingCallback, { agent: config.agent.name, requester: requester.name });
    return connectCall({ mode: "task", conversationId: conversation.id, taskId: task.id, userId: requester.id, greeting });
  }

  const conversation = await createConversation({ kind: "unknown_call", counterpartPhone: from, direction: "inbound", callSid });
  await addMessage(conversation.id, "event", "Call from a number that is not invited; rejected");
  return sayAndHangup("Sorry, this number only takes calls from invited users. Goodbye.");
}

/**
 * An outbound task call was answered: Twilio fetches its instructions now, so
 * the greeting (from current settings) and GPT-Live start exactly at pickup.
 */
voiceRouter.post("/twilio/voice/answered/:conversationId", requireTwilioSignature, async (req, res) => {
  try {
    const conversation = await queryOne<Conversation>(
      "SELECT * FROM conversations WHERE id = $1 AND kind = 'task_call' AND direction = 'outbound'",
      [Number(req.params.conversationId)],
    );
    const callSid = String(req.body.CallSid ?? "");
    const task = conversation?.task_id ? await getTask(conversation.task_id) : undefined;
    const requester = task && (await getUser(task.user_id));
    if (!conversation || !task || !requester || (conversation.call_sid && conversation.call_sid !== callSid)) {
      return void res.type("text/xml").send("<Response><Hangup/></Response>");
    }
    const settings = await getSettings();
    if (!settings.callsEnabled || task.status === "cancelled") {
      await addMessage(conversation.id, "event", "Call answered after calls were turned off or the task was cancelled; hung up");
      return void res.type("text/xml").send("<Response><Hangup/></Response>");
    }
    const greeting = fillGreeting(settings.greetingOutbound, {
      agent: config.agent.name,
      requester: requester.name,
      recipient: task.target_name || "there",
    });
    res
      .type("text/xml")
      .send(connectCall({ mode: "task", conversationId: conversation.id, taskId: task.id, userId: requester.id, greeting, speakFirst: true }));
  } catch (err) {
    console.error("Answered-call setup failed", err);
    res.type("text/xml").send("<Response><Hangup/></Response>");
  }
});

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
    if (status === "completed" || NOT_CONNECTED.has(status)) dropPrewarmedCall(conversation.id);
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
