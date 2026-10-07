import { config } from "./config.js";
import {
  addMessage,
  createConversation,
  getUser,
  isBlocked,
  query,
  queryOne,
  type Conversation,
  type Task,
  type User,
} from "./db/index.js";
import { countryOf, formatPhone, toE164 } from "./phone.js";
import { sendSms, twilioClient } from "./twilio.js";
import { createRelaySession } from "./voice/sessions.js";
import { buildCallTwiml } from "./voice/twiml.js";

export class TaskError extends Error {}

/** Shared checks before contacting any third-party number. */
export async function checkOutboundAllowed(user: User, rawPhone: string): Promise<string> {
  const phone = toE164(rawPhone);
  if (!phone) throw new TaskError(`"${rawPhone}" is not a valid phone number.`);
  if (phone === config.twilio.phoneNumber) throw new TaskError("That is my own number.");
  const country = countryOf(phone);
  if (!country || !config.agent.allowedCountries.includes(country)) {
    throw new TaskError(`Contacting numbers in ${country ?? "that country"} is not allowed.`);
  }
  if (isEmergencyOrShortCode(phone)) throw new TaskError("I can't contact emergency or special service numbers.");
  if (await isBlocked(phone)) throw new TaskError("That number has opted out or been blocked by the administrator.");

  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: config.agent.timezone }).format(new Date()),
  ) % 24;
  if (hour < config.agent.contactHoursStart || hour >= config.agent.contactHoursEnd) {
    throw new TaskError(
      `I only contact people between ${config.agent.contactHoursStart}:00 and ${config.agent.contactHoursEnd}:00 (${config.agent.timezone}). Please ask again then.`,
    );
  }

  const row = await queryOne<{ count: string }>(
    "SELECT count(*) FROM tasks WHERE user_id = $1 AND created_at > now() - interval '1 day'",
    [user.id],
  );
  if (Number(row?.count ?? 0) >= config.agent.maxOutboundPerUserPerDay) {
    throw new TaskError("You've reached today's limit for outbound calls and texts.");
  }
  return phone;
}

function isEmergencyOrShortCode(e164: string): boolean {
  const digits = e164.replace(/\D/g, "");
  return digits.length < 10 || /^1?(911|988|112|999)$/.test(digits);
}

async function createTask(user: User, t: {
  kind: "call" | "sms";
  phone: string;
  targetName: string;
  objective: string;
  context: string;
}): Promise<Task> {
  const task = await queryOne<Task>(
    `INSERT INTO tasks (user_id, kind, target_phone, target_name, objective, context, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'in_progress') RETURNING *`,
    [user.id, t.kind, t.phone, t.targetName, t.objective, t.context],
  );
  return task!;
}

export function callGreeting(user: User, targetName: string): string {
  const who = targetName ? `Hi ${targetName}, this` : "Hi, this";
  return `${who} is ${config.agent.name}, an AI assistant calling on behalf of ${user.name}. This call is being recorded and transcribed. Is now a good time for a quick question?`;
}

export async function startCallTask(user: User, input: {
  phone: string;
  recipientName: string;
  objective: string;
  context: string;
}): Promise<Task> {
  const phone = await checkOutboundAllowed(user, input.phone);
  const task = await createTask(user, { kind: "call", phone, targetName: input.recipientName, objective: input.objective, context: input.context });
  await placeTaskCall(task, user);
  return task;
}

export async function placeTaskCall(task: Task, user: User): Promise<void> {
  const conversation = await createConversation({
    kind: "task_call",
    userId: user.id,
    taskId: task.id,
    counterpartPhone: task.target_phone,
    direction: "outbound",
  });
  const greeting = callGreeting(user, task.target_name);
  const token = createRelaySession({ mode: "task", conversationId: conversation.id, taskId: task.id, userId: user.id, greeting });
  try {
    const call = await twilioClient.calls.create({
      to: task.target_phone,
      from: config.twilio.phoneNumber,
      twiml: buildCallTwiml(token, greeting),
      record: true,
      recordingStatusCallback: `${config.publicBaseUrl}/twilio/voice/recording`,
      recordingStatusCallbackEvent: ["completed"],
      statusCallback: `${config.publicBaseUrl}/twilio/voice/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeLimit: config.agent.maxCallMinutes * 60,
    });
    await query("UPDATE conversations SET call_sid = $1, call_status = 'queued' WHERE id = $2", [call.sid, conversation.id]);
    await addMessage(conversation.id, "event", `Outbound call placed to ${formatPhone(task.target_phone)} for task #${task.id}`);
  } catch (err) {
    await addMessage(conversation.id, "event", `Call failed to start: ${(err as Error).message}`);
    await finishTask(task.id, "failed", `The call could not be placed: ${(err as Error).message}`);
    throw new TaskError(`The call could not be placed: ${(err as Error).message}`);
  }
}

export async function startSmsTask(user: User, input: {
  phone: string;
  recipientName: string;
  message: string;
  objective: string;
  context: string;
}): Promise<Task> {
  const phone = await checkOutboundAllowed(user, input.phone);
  const task = await createTask(user, { kind: "sms", phone, targetName: input.recipientName, objective: input.objective, context: input.context });
  const conversation = await createConversation({ kind: "task_sms", userId: user.id, taskId: task.id, counterpartPhone: phone, direction: "outbound" });
  const body = `${input.message.trim()}\n\n- ${config.agent.name}, an AI assistant texting for ${user.name}. Reply STOP to opt out.`;
  try {
    const sids = await sendSms(phone, body);
    await addMessage(conversation.id, "assistant", body, sids[0]);
  } catch (err) {
    await finishTask(task.id, "failed", `The text could not be sent: ${(err as Error).message}`);
    throw new TaskError(`The text could not be sent: ${(err as Error).message}`);
  }
  return task;
}

/** Mark a task finished and text the requester the result (once). */
export async function finishTask(taskId: number, status: "completed" | "failed" | "cancelled", result: string): Promise<void> {
  const task = await queryOne<Task>(
    `UPDATE tasks SET status = $2, result = $3, completed_at = now()
     WHERE id = $1 AND status IN ('pending', 'in_progress') RETURNING *`,
    [taskId, status, result],
  );
  if (!task || status === "cancelled") return;
  const user = await getUser(task.user_id);
  if (!user?.active) return;
  const who = task.target_name || formatPhone(task.target_phone);
  const verb = task.kind === "call" ? "Call with" : "Texts with";
  await notifyUser(user, `${verb} ${who} (task #${task.id}) ${status === "completed" ? "done" : "failed"}:\n${result}`);
}

/** Text an invited user and record it in their SMS thread so the agent remembers it. */
export async function notifyUser(user: User, body: string): Promise<void> {
  const conversation = await userSmsConversation(user);
  const sids = await sendSms(user.phone, body);
  await addMessage(conversation.id, "assistant", body, sids[0]);
}

export async function userSmsConversation(user: User): Promise<Conversation> {
  const existing = await queryOne<Conversation>(
    "SELECT * FROM conversations WHERE kind = 'user_sms' AND user_id = $1 ORDER BY id DESC LIMIT 1",
    [user.id],
  );
  return existing ?? createConversation({ kind: "user_sms", userId: user.id, counterpartPhone: user.phone, direction: "inbound" });
}

export async function recentTasks(userId: number, limit = 10): Promise<Task[]> {
  return query<Task>("SELECT * FROM tasks WHERE user_id = $1 ORDER BY id DESC LIMIT $2", [userId, limit]);
}

export function describeTask(t: Task): string {
  const who = t.target_name ? `${t.target_name} (${formatPhone(t.target_phone)})` : formatPhone(t.target_phone);
  const when = t.created_at.toISOString().slice(0, 16).replace("T", " ");
  return `#${t.id} ${t.kind} to ${who}, ${when} UTC, status ${t.status}. Objective: ${t.objective}${t.result ? `\nResult: ${t.result}` : ""}`;
}
