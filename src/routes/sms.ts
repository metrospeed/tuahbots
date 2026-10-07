import express from "express";
import { runAgent } from "../agent/claude.js";
import { historyFromTranscript, taskBrief, userDetails } from "../agent/context.js";
import { taskSmsPrompt, USER_ASSISTANT_PROMPT } from "../agent/prompts.js";
import { taskSmsTools, userTools } from "../agent/tools.js";
import {
  addMessage,
  createConversation,
  findActiveUserByPhone,
  getTask,
  getUser,
  isBlocked,
  pool,
  query,
  queryOne,
  type Conversation,
  type Task,
  type User,
} from "../db/index.js";
import { withLock } from "../lock.js";
import { toE164 } from "../phone.js";
import { finishTask, userSmsConversation } from "../tasks.js";
import { fetchMedia, requireTwilioSignature, sendSms } from "../twilio.js";

export const smsRouter = express.Router();

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const OPT_IN = /^\s*(start|unstop|yes)\s*$/i;
/** How long after a task a third party's texts or calls are still routed to it. */
export const TASK_REPLY_WINDOW = "30 days";

smsRouter.post("/twilio/sms", requireTwilioSignature, (req, res) => {
  // Reply right away; the agent may take longer than Twilio's webhook timeout.
  res.type("text/xml").send("<Response/>");
  handleInboundSms(req.body).catch((err) => console.error("Inbound SMS handling failed", err));
});

smsRouter.post("/twilio/sms/status", requireTwilioSignature, (req, res) => {
  if (req.body.MessageStatus === "failed" || req.body.MessageStatus === "undelivered") {
    console.warn(`SMS ${req.body.MessageSid} to ${req.body.To} ${req.body.MessageStatus}: ${req.body.ErrorCode ?? ""}`);
  }
  res.sendStatus(204);
});

interface InboundSms {
  From: string;
  Body?: string;
  MessageSid: string;
  NumMedia?: string;
  [key: string]: string | undefined;
}

async function handleInboundSms(params: InboundSms): Promise<void> {
  const from = toE164(params.From) ?? params.From;
  const body = (params.Body ?? "").trim();

  const user = await findActiveUserByPhone(from);
  if (user) return withLock(`user:${user.id}`, () => handleUserSms(user, params, body));

  if (OPT_OUT.test(body)) {
    await query("INSERT INTO blocked_numbers (phone, reason) VALUES ($1, 'Opted out by SMS') ON CONFLICT DO NOTHING", [from]);
    const open = await query<Task>("SELECT * FROM tasks WHERE target_phone = $1 AND status IN ('pending', 'in_progress')", [from]);
    for (const task of open) await finishTask(task.id, "completed", "The recipient replied STOP and opted out of texts.");
  } else if (OPT_IN.test(body)) {
    await query("DELETE FROM blocked_numbers WHERE phone = $1 AND reason = 'Opted out by SMS'", [from]);
  }

  const task = await latestTaskForNumber(from);
  if (task) return withLock(`task:${task.id}`, () => handleCounterpartSms(task, from, params, body));

  // Unknown sender: keep a record for the admin but don't reply.
  const conversation =
    (await queryOne<Conversation>(
      "SELECT * FROM conversations WHERE kind = 'unknown_sms' AND counterpart_phone = $1 ORDER BY id DESC LIMIT 1",
      [from],
    )) ?? (await createConversation({ kind: "unknown_sms", counterpartPhone: from, direction: "inbound" }));
  await saveInbound(conversation.id, "counterpart", params, body);
}

export async function latestTaskForNumber(phone: string): Promise<Task | undefined> {
  return queryOne<Task>(
    `SELECT * FROM tasks WHERE target_phone = $1 AND status <> 'cancelled'
       AND created_at > now() - interval '${TASK_REPLY_WINDOW}'
     ORDER BY id DESC LIMIT 1`,
    [phone],
  );
}

async function saveInbound(conversationId: number, role: "user" | "counterpart", params: InboundSms, body: string): Promise<void> {
  const message = await addMessage(conversationId, role, body, params.MessageSid);
  const count = Number(params.NumMedia ?? 0);
  for (let i = 0; i < count; i++) {
    const url = params[`MediaUrl${i}`];
    if (!url) continue;
    try {
      const media = await fetchMedia(url);
      if (media.data.length > MAX_MEDIA_BYTES) {
        await addMessage(conversationId, "event", `Attachment skipped: ${media.contentType} larger than 10 MB`);
        continue;
      }
      await pool.query("INSERT INTO attachments (message_id, content_type, data) VALUES ($1, $2, $3)", [
        message.id,
        media.contentType,
        media.data,
      ]);
    } catch (err) {
      console.error("Failed to download MMS media", err);
      await addMessage(conversationId, "event", `Attachment could not be downloaded`);
    }
  }
}

async function reply(conversationId: number, to: string, text: string): Promise<void> {
  if (!text.trim()) return;
  const sids = await sendSms(to, text);
  await addMessage(conversationId, "assistant", text, sids[0]);
}

async function handleUserSms(user: User, params: InboundSms, body: string): Promise<void> {
  const conversation = await userSmsConversation(user);
  await saveInbound(conversation.id, "user", params, body);
  const messages = await historyFromTranscript(conversation.id, "user");
  try {
    const result = await runAgent({
      system: USER_ASSISTANT_PROMPT,
      systemDetails: await userDetails(user),
      messages,
      tools: userTools(user, conversation.id),
      effort: "medium",
    });
    await reply(conversation.id, user.phone, result.text);
  } catch (err) {
    console.error("User SMS agent failed", err);
    await reply(conversation.id, user.phone, "Sorry, something went wrong on my end. Please try again in a minute.");
  }
}

async function taskSmsConversation(task: Task): Promise<Conversation> {
  return (
    (await queryOne<Conversation>("SELECT * FROM conversations WHERE kind = 'task_sms' AND task_id = $1 ORDER BY id DESC LIMIT 1", [task.id])) ??
    (await createConversation({ kind: "task_sms", userId: task.user_id, taskId: task.id, counterpartPhone: task.target_phone, direction: "inbound" }))
  );
}

async function handleCounterpartSms(task: Task, from: string, params: InboundSms, body: string): Promise<void> {
  const conversation = await taskSmsConversation(task);
  await saveInbound(conversation.id, "counterpart", params, body);
  if (OPT_OUT.test(body)) return;
  await runTaskSmsAgent(task.id, conversation);
}

/** Inject an instruction into a text task's thread and let its agent act on it. */
export function continueSmsTask(taskId: number, note: string): Promise<void> {
  return withLock(`task:${taskId}`, async () => {
    const task = await getTask(taskId);
    if (!task) return;
    const conversation = await taskSmsConversation(task);
    await addMessage(conversation.id, "event", note);
    await runTaskSmsAgent(taskId, conversation);
  });
}

async function runTaskSmsAgent(taskId: number, conversation: Conversation): Promise<void> {
  const task = await getTask(taskId);
  const user = task && (await getUser(task.user_id));
  if (!task || !user || task.status === "cancelled" || (await isBlocked(task.target_phone))) return;
  const messages = await historyFromTranscript(conversation.id, "counterpart");
  if (!messages.length) return;
  try {
    const result = await runAgent({
      system: taskSmsPrompt(),
      systemDetails: taskBrief(task, user),
      messages,
      tools: taskSmsTools(task, user, conversation.id),
      effort: "medium",
    });
    await reply(conversation.id, task.target_phone, result.text);
  } catch (err) {
    console.error(`Task #${task.id} SMS agent failed`, err);
  }
}
