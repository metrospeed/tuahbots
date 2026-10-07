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
import { twilioClient } from "./twilio.js";
import { recordCalledNumber } from "./numbers.js";
import { getSettings } from "./settings.js";

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

  const settings = await getSettings();
  if (!settings.callsEnabled) throw new TaskError("Calling is turned off by the administrator right now.");
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: settings.timezone }).format(new Date()),
  ) % 24;
  if (hour < settings.contactHoursStart || hour >= settings.contactHoursEnd) {
    throw new TaskError(
      `I only call people between ${settings.contactHoursStart}:00 and ${settings.contactHoursEnd}:00 (${settings.timezone}). Please ask again then.`,
    );
  }

  const row = await queryOne<{ count: string }>(
    "SELECT count(*) FROM tasks WHERE user_id = $1 AND created_at > now() - interval '1 day'",
    [user.id],
  );
  if (Number(row?.count ?? 0) >= config.agent.maxOutboundPerUserPerDay) {
    throw new TaskError("You've reached today's limit for calls.");
  }
  return phone;
}

function isEmergencyOrShortCode(e164: string): boolean {
  const digits = e164.replace(/\D/g, "");
  return digits.length < 10 || /^1?(911|988|112|999)$/.test(digits);
}

async function createTask(user: User, t: {
  kind: "call";
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

export async function startCallTask(user: User, input: {
  phone: string;
  recipientName: string;
  objective: string;
  context: string;
}): Promise<Task> {
  const phone = await checkOutboundAllowed(user, input.phone);
  const task = await createTask(user, { kind: "call", phone, targetName: input.recipientName, objective: input.objective, context: input.context });
  await recordCalledNumber(user.id, phone, input.recipientName);
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
  const settings = await getSettings();
  try {
    // Twilio fetches the call's instructions when it's answered, so the
    // greeting and GPT-Live start exactly at pickup.
    const call = await twilioClient.calls.create({
      to: task.target_phone,
      from: config.twilio.phoneNumber,
      url: `${config.publicBaseUrl}/twilio/voice/answered/${conversation.id}`,
      method: "POST",
      record: true,
      recordingStatusCallback: `${config.publicBaseUrl}/twilio/voice/recording`,
      recordingStatusCallbackEvent: ["completed"],
      statusCallback: `${config.publicBaseUrl}/twilio/voice/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      // Hard stop a minute after the agent is told to wrap up.
      timeLimit: (settings.maxCallMinutes + 1) * 60,
    });
    await query("UPDATE conversations SET call_sid = $1, call_status = 'queued' WHERE id = $2", [call.sid, conversation.id]);
    await addMessage(conversation.id, "event", `Outbound call placed to ${formatPhone(task.target_phone)} for task #${task.id}`);
  } catch (err) {
    await addMessage(conversation.id, "event", `Call failed to start: ${(err as Error).message}`);
    await finishTask(task.id, "failed", `The call could not be placed: ${(err as Error).message}`);
    throw new TaskError(`The call could not be placed: ${(err as Error).message}`);
  }
}

/** Mark a task finished and post the result to the requester's chat (once). */
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
  await notifyUser(user, `Call with ${who} (task #${task.id}) ${status === "completed" ? "done" : "failed"}:\n${result}`);
}

/** Post a message from the agent into a user's web chat. */
export async function notifyUser(user: User, body: string): Promise<void> {
  const conversation = await userChatConversation(user);
  await addMessage(conversation.id, "assistant", body);
}

/** Each invited user has one long-running web chat thread with the agent. */
export async function userChatConversation(user: User): Promise<Conversation> {
  const existing = await queryOne<Conversation>(
    "SELECT * FROM conversations WHERE kind = 'user_web' AND user_id = $1 AND cleared_at IS NULL ORDER BY id DESC LIMIT 1",
    [user.id],
  );
  return existing ?? createConversation({ kind: "user_web", userId: user.id, counterpartPhone: user.phone ?? "", direction: "inbound" });
}

/** A user's tasks since they last cleared their chat (what they and their agent see). */
export async function recentTasks(userId: number, limit = 10): Promise<Task[]> {
  return query<Task>(
    `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
     WHERE t.user_id = $1 AND (u.chat_cleared_at IS NULL OR t.created_at > u.chat_cleared_at)
     ORDER BY t.id DESC LIMIT $2`,
    [userId, limit],
  );
}

/** One of the user's tasks, if it's still visible to them (created since their last clear). */
export async function visibleTask(userId: number, taskId: number): Promise<Task | undefined> {
  return queryOne<Task>(
    `SELECT t.* FROM tasks t JOIN users u ON u.id = t.user_id
     WHERE t.id = $1 AND t.user_id = $2 AND (u.chat_cleared_at IS NULL OR t.created_at > u.chat_cleared_at)`,
    [taskId, userId],
  );
}

export function describeTask(t: Task): string {
  const who = t.target_name ? `${t.target_name} (${formatPhone(t.target_phone)})` : formatPhone(t.target_phone);
  const when = t.created_at.toISOString().slice(0, 16).replace("T", " ");
  return `#${t.id} ${t.kind} to ${who}, ${when} UTC, status ${t.status}. Objective: ${t.objective}${t.result ? `\nResult: ${t.result}` : ""}`;
}
