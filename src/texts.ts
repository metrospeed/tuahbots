import { AgentRunError, runAgent, type AgentTool } from "./agent/llm.js";
import { historyFromTranscript, taskBrief } from "./agent/context.js";
import { loadPromptOverrides, taskTextPrompt } from "./agent/prompts.js";
import { loadAiSettings, redact } from "./agent/provider.js";
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
  type Task,
  type User,
} from "./db/index.js";
import { withLock } from "./lock.js";
import { callbackTaskForNumber } from "./numbers.js";
import { formatPhone } from "./phone.js";
import { getSettings } from "./settings.js";
import { sendTextMessage } from "./sms.js";
import { finishTask, notifyUser, userChatConversation } from "./tasks.js";
import { postUserMessage } from "./web/chat.js";

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|opt[ -]?out)\s*[.!]*\s*$/i;
const OPT_IN = /^\s*(start|unstop|opt[ -]?in)\s*[.!]*\s*$/i;
const OPT_OUT_REASON = "Opted out by text";
/** The agent stops replying in a thread after this many texts in a day (e.g. an auto-responder loop). */
export const MAX_AGENT_TEXTS_PER_TASK_PER_DAY = 15;

export interface InboundText {
  from: string;
  body: string;
  /** httpSMS message id: a repeated webhook for the same text is ignored. */
  smsId: string;
}

/** Someone texted the httpSMS phone. */
export async function handleInboundText(text: InboundText): Promise<void> {
  if (await queryOne("SELECT 1 FROM messages WHERE sms_id = $1", [text.smsId])) return;

  const user = await findActiveUserByPhone(text.from);
  if (user) return handleUserText(user, text);

  if (OPT_OUT.test(text.body)) return optOut(text);
  if (OPT_IN.test(text.body)) return optIn(text);

  // Someone the agent contacted for a user who still lets that number reach them.
  const task = (await isBlocked(text.from)) ? undefined : await callbackTaskForNumber(text.from);
  if (task) return withLock(`task:${task.id}`, () => handleCounterpartText(task, text));

  await logUnknownText(text);
}

/** Keep a record of texts from anyone else, for the admin, without replying. */
async function logUnknownText(text: InboundText): Promise<void> {
  const conversation =
    (await queryOne<Conversation>(
      "SELECT * FROM conversations WHERE kind = 'unknown_sms' AND counterpart_phone = $1 ORDER BY id DESC LIMIT 1",
      [text.from],
    )) ?? (await createConversation({ kind: "unknown_sms", counterpartPhone: text.from, direction: "inbound" }));
  await addMessage(conversation.id, "counterpart", text.body, undefined, { smsId: text.smsId });
}

/**
 * An invited user texting the agent: it's part of their web chat, and the
 * reply is texted back. STOP switches that off (replies stay in the web
 * chat) until they text START.
 */
async function handleUserText(user: User, text: InboundText): Promise<void> {
  const note = async (event: string) => addMessage((await userChatConversation(user)).id, "event", event);
  if (!(await getSettings()).textsEnabled) {
    await postUserMessage(user, text.body, [], { smsId: text.smsId, answer: false });
    await note("Texting is turned off; this text wasn't answered");
    return;
  }
  if (OPT_OUT.test(text.body)) {
    await postUserMessage(user, text.body, [], { smsId: text.smsId, answer: false });
    await sendTextMessage(await userChatConversation(user), text.from, "Okay, I won't text you anymore. Text START to turn texts back on, or use the web chat.").catch(() => undefined);
    await query("INSERT INTO blocked_numbers (phone, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [text.from, OPT_OUT_REASON]);
    await note("They asked for no more texts; replies go to the web chat only");
    return;
  }
  if (OPT_IN.test(text.body)) {
    await query("DELETE FROM blocked_numbers WHERE phone = $1 AND reason = $2", [text.from, OPT_OUT_REASON]);
  }
  await postUserMessage(user, text.body, [], { smsId: text.smsId });
}

/** START after a STOP: lift the block. Nothing is sent back. */
async function optIn(text: InboundText): Promise<void> {
  await query("DELETE FROM blocked_numbers WHERE phone = $1 AND reason = $2", [text.from, OPT_OUT_REASON]);
  const thread = await queryOne<Conversation>(
    "SELECT * FROM conversations WHERE kind = 'task_sms' AND counterpart_phone = $1 ORDER BY id DESC LIMIT 1",
    [text.from],
  );
  if (!thread) return logUnknownText(text);
  await addMessage(thread.id, "counterpart", text.body, undefined, { smsId: text.smsId });
  await addMessage(thread.id, "event", "They opted back in to texts");
}

/**
 * STOP: block the number (no more calls or texts), close its open tasks, and
 * confirm once if the agent had been texting them.
 */
async function optOut(text: InboundText): Promise<void> {
  await query("INSERT INTO blocked_numbers (phone, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING", [text.from, OPT_OUT_REASON]);
  const thread = await queryOne<Conversation>(
    "SELECT * FROM conversations WHERE kind = 'task_sms' AND counterpart_phone = $1 ORDER BY id DESC LIMIT 1",
    [text.from],
  );
  if (!thread) return logUnknownText(text);
  await addMessage(thread.id, "counterpart", text.body, undefined, { smsId: text.smsId });
  await addMessage(thread.id, "event", "They opted out; the number is now blocked");
  const open = await query<Task>("SELECT * FROM tasks WHERE target_phone = $1 AND status IN ('pending', 'in_progress')", [text.from]);
  for (const task of open) await finishTask(task.id, "completed", "They replied STOP and opted out. I won't contact this number again.");
  await sendTextMessage(thread, text.from, "You won't get any more texts from this number.").catch(() => undefined);
}

async function taskTextConversation(task: Task): Promise<Conversation> {
  return (
    (await queryOne<Conversation>("SELECT * FROM conversations WHERE kind = 'task_sms' AND task_id = $1 ORDER BY id DESC LIMIT 1", [task.id])) ??
    (await createConversation({ kind: "task_sms", userId: task.user_id, taskId: task.id, counterpartPhone: task.target_phone, direction: "inbound" }))
  );
}

async function handleCounterpartText(task: Task, text: InboundText): Promise<void> {
  const conversation = await taskTextConversation(task);
  await addMessage(conversation.id, "counterpart", text.body, undefined, { smsId: text.smsId });
  // Like a call-back, a reply reopens the task; the agent completes it again with what's new.
  await query("UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1 AND status <> 'cancelled'", [task.id]);
  await runTaskTextAgent(task.id, conversation);
}

/** The requester sent new instructions for a text task: note them in the thread and let its agent text. */
export function continueTextTask(taskId: number, instructions: string): Promise<void> {
  return withLock(`task:${taskId}`, async () => {
    const task = await getTask(taskId);
    if (!task) return;
    await query("UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1", [task.id]);
    const conversation = await taskTextConversation(task);
    await addMessage(conversation.id, "event", `The requester sent follow-up instructions: ${instructions}\nText the other person about it now.`);
    await runTaskTextAgent(task.id, conversation, true);
  });
}

async function runTaskTextAgent(taskId: number, conversation: Conversation, followUp = false): Promise<void> {
  const task = await getTask(taskId);
  const user = task && (await getUser(task.user_id));
  if (!task || !user?.active || task.status === "cancelled" || (await isBlocked(task.target_phone))) return;
  if (!(await getSettings()).textsEnabled) {
    await addMessage(conversation.id, "event", "Texting is turned off; not answered");
    return;
  }
  // A burst of texts is answered once: an earlier run may already have seen this one.
  const last = await queryOne<{ role: string }>(
    "SELECT role FROM messages WHERE conversation_id = $1 AND role IN ('counterpart', 'assistant') ORDER BY id DESC LIMIT 1",
    [conversation.id],
  );
  if (!followUp && last?.role !== "counterpart") return;
  if (await overDailyLimit(task, conversation, user)) return;

  try {
    await loadPromptOverrides();
    await loadAiSettings();
    const result = await runAgent({
      system: taskTextPrompt(),
      systemDetails: taskBrief(task, user),
      messages: await historyFromTranscript(conversation.id, "counterpart"),
      tools: taskTextTools(task, user, conversation.id),
      effort: "medium",
    });
    if (result.text.trim()) await sendTextMessage(conversation, task.target_phone, result.text);
  } catch (err) {
    const cause = err instanceof AgentRunError ? err.cause : err;
    console.error(`Task #${task.id} text agent failed`, redact((cause as Error)?.stack ?? String(cause)));
    await addMessage(conversation.id, "event", "The agent couldn't answer this text");
  }
}

async function overDailyLimit(task: Task, conversation: Conversation, user: User): Promise<boolean> {
  const row = await queryOne<{ sent: number; warned: number }>(
    `SELECT count(*) FILTER (WHERE m.role = 'assistant')::int AS sent,
            count(*) FILTER (WHERE m.role = 'event' AND m.body LIKE 'Reply limit reached%')::int AS warned
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.task_id = $1 AND c.kind = 'task_sms' AND m.created_at > now() - interval '1 day'`,
    [task.id],
  );
  if ((row?.sent ?? 0) < MAX_AGENT_TEXTS_PER_TASK_PER_DAY) return false;
  if (!row?.warned) {
    await addMessage(conversation.id, "event", `Reply limit reached (${MAX_AGENT_TEXTS_PER_TASK_PER_DAY} texts today); not answering`);
    const who = task.target_name || formatPhone(task.target_phone);
    await notifyUser(user, `${who} keeps texting about task #${task.id}. I've stopped replying for today; the thread is in your calls list.`);
  }
  return true;
}

const str = (description: string) => ({ type: "string", description });

/** Tools for the agent texting with a third party. */
function taskTextTools(task: Task, user: User, conversationId: number): AgentTool[] {
  return [
    {
      definition: {
        name: "complete_task",
        description: "Finish the task and report the outcome to the requester.",
        parameters: {
          type: "object",
          properties: { result: str("Concise, complete summary of what was learned or agreed, with exact figures and dates.") },
          required: ["result"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        await finishTask(task.id, "completed", String(input.result));
        await addMessage(conversationId, "event", `Task #${task.id} completed`);
        return "Task completed and the requester has been told.";
      },
    },
    {
      definition: {
        name: "message_requester",
        description: "Send the requester a question or update, e.g. when the other person asks something only the requester can answer.",
        parameters: {
          type: "object",
          properties: { message: str("The message to the requester.") },
          required: ["message"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const message = String(input.message);
        const who = task.target_name || formatPhone(task.target_phone);
        await notifyUser(user, `About task #${task.id} (texting ${who}): ${message}`);
        await addMessage(conversationId, "event", `Messaged the requester: ${message}`);
        return "Sent to the requester. Their answer will arrive as follow-up instructions.";
      },
    },
  ];
}

/** A text the agent sent couldn't be delivered (httpSMS gave up). */
export async function handleTextFailed(messageId: number, reason: string): Promise<void> {
  const message = await queryOne<{ conversation_id: number; body: string }>("SELECT conversation_id, body FROM messages WHERE id = $1", [messageId]);
  if (!message) return;
  const conversation = await queryOne<Conversation>("SELECT * FROM conversations WHERE id = $1", [message.conversation_id]);
  if (!conversation) return;
  await addMessage(conversation.id, "event", `Text not delivered: ${reason || "unknown error"}`);
  // If not even the first text arrived, the task can't go anywhere.
  if (conversation.kind === "task_sms" && conversation.task_id) {
    const sent = await queryOne<{ id: number }>(
      "SELECT min(id) AS id FROM messages WHERE conversation_id = $1 AND role = 'assistant'",
      [conversation.id],
    );
    const replied = await queryOne("SELECT 1 FROM messages WHERE conversation_id = $1 AND role = 'counterpart'", [conversation.id]);
    if (sent?.id === messageId && !replied) await finishTask(conversation.task_id, "failed", `My text couldn't be delivered: ${reason || "unknown error"}.`);
  }
}
