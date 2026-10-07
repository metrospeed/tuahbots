import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../config.js";
import { listMessages, query, type Attachment, type Message, type Task, type User } from "../db/index.js";
import { formatPhone } from "../phone.js";
import { describeTask, recentTasks, userChatConversation } from "../tasks.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Only the most recent files are sent to the model, to bound cost. */
const MAX_ATTACHMENTS_IN_CONTEXT = 4;

export function nowLine(): string {
  const now = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: config.agent.timezone,
  }).format(new Date());
  return `Current time: ${now} (${config.agent.timezone}).`;
}

export async function userDetails(user: User): Promise<string> {
  const tasks = await recentTasks(user.id, 5);
  return [
    nowLine(),
    `You are talking with ${user.name}${user.phone ? ` (${formatPhone(user.phone)})` : ""}.`,
    user.notes ? `Notes about this user from the administrator: ${user.notes}` : "",
    tasks.length ? `Their most recent tasks:\n${tasks.map(describeTask).join("\n\n")}` : "They have no tasks yet.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function taskBrief(task: Task, requester: User): string {
  return [
    nowLine(),
    `Requester: ${requester.name}.`,
    `You are contacting: ${task.target_name || "unknown name"} at ${formatPhone(task.target_phone)}.`,
    `Objective: ${task.objective}`,
    `Brief from the requester:\n${task.context || "(none)"}`,
  ].join("\n\n");
}

async function attachmentsFor(messageIds: number[]): Promise<Map<number, Attachment[]>> {
  const map = new Map<number, Attachment[]>();
  if (!messageIds.length) return map;
  const rows = await query<Attachment>(
    "SELECT * FROM attachments WHERE message_id = ANY($1) ORDER BY id DESC LIMIT $2",
    [messageIds, MAX_ATTACHMENTS_IN_CONTEXT],
  );
  for (const row of rows) map.set(row.message_id, [...(map.get(row.message_id) ?? []), row]);
  return map;
}

export function attachmentBlock(a: Attachment): BetaContentBlockParam {
  if (IMAGE_TYPES.has(a.content_type)) {
    return { type: "image", source: { type: "base64", media_type: a.content_type as "image/png", data: a.data.toString("base64") } };
  }
  if (a.content_type === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data.toString("base64") } };
  }
  if (a.content_type.startsWith("text/")) {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: a.data.toString("utf8") } };
  }
  return { type: "text", text: `[Attachment of type ${a.content_type} that I can't read]` };
}

/**
 * Rebuild a Claude conversation from a stored transcript. `selfRole` is the
 * stored role that maps to Claude's user turns ('user' for invited users,
 * 'counterpart' for third parties). Events are folded in as bracketed notes.
 */
export async function historyFromTranscript(
  conversationId: number,
  selfRole: "user" | "counterpart",
  limit = 40,
): Promise<BetaMessageParam[]> {
  const rows = await listMessages(conversationId, limit);
  const attachments = await attachmentsFor(rows.filter((m) => m.role === selfRole).map((m) => m.id));
  const messages: BetaMessageParam[] = [];

  const push = (role: "user" | "assistant", blocks: BetaContentBlockParam[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) (last.content as BetaContentBlockParam[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of rows as Message[]) {
    if (m.role === "assistant") {
      if (m.body) push("assistant", [{ type: "text", text: m.body }]);
    } else if (m.role === selfRole) {
      const blocks: BetaContentBlockParam[] = (attachments.get(m.id) ?? []).map(attachmentBlock);
      if (blocks.length) blocks.unshift({ type: "text", text: `[Sent ${m.created_at.toISOString()} with ${blocks.length} attachment(s):]` });
      blocks.push({ type: "text", text: m.body || "(no text)" });
      push("user", blocks);
    } else if (m.role === "event") {
      push("user", [{ type: "text", text: `[note: ${m.body}]` }]);
    }
  }

  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

/** A calling user's recent web chat and files (e.g. a quote they uploaded), as Claude content. */
export async function recentChatContext(user: User): Promise<BetaContentBlockParam[]> {
  const thread = await userChatConversation(user);
  const recent = (await listMessages(thread.id, 20)).filter((m) => m.role !== "event");
  const blocks: BetaContentBlockParam[] = [];
  const files = await query<Attachment>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id = $1 AND a.created_at > now() - interval '7 days' ORDER BY a.id DESC LIMIT 3`,
    [thread.id],
  );
  if (files.length) {
    blocks.push({ type: "text", text: "[Files the user recently uploaded in the chat:]" });
    blocks.push(...files.map(attachmentBlock));
  }
  const transcript = recent.map((m) => `${m.role === "assistant" ? "You" : "User"}: ${m.body}`).join("\n");
  blocks.push({
    type: "text",
    text: `${transcript ? `[Your recent chat messages with the user:]\n${transcript}\n\n` : ""}[The user is now calling you.]`,
  });
  return blocks;
}
