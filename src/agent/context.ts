import type { ContentPart, InputItem } from "./llm.js";
import { listMessages, query, type Attachment, type Message, type Task, type User } from "../db/index.js";
import { formatPhone } from "../phone.js";
import { currentTimezone, getSettings } from "../settings.js";
import { describeTask, recentTasks, userChatConversation } from "../tasks.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Only the most recent files are sent to the model, to bound cost. */
const MAX_ATTACHMENTS_IN_CONTEXT = 4;

export function nowLine(): string {
  const timeZone = currentTimezone();
  const now = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(new Date());
  return `Current time: ${now} (${timeZone}).`;
}

export async function userDetails(user: User): Promise<string> {
  const tasks = await recentTasks(user.id, 5);
  const settings = await getSettings();
  return [
    nowLine(),
    settings.callsEnabled
      ? `Calls to other people can be placed between ${settings.contactHoursStart}:00 and ${settings.contactHoursEnd}:00 (${settings.timezone}).`
      : "Calling is currently turned off by the administrator. You can't place calls; tell the user if they ask.",
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

export function attachmentPart(a: Attachment): ContentPart {
  const dataUrl = `data:${a.content_type};base64,${a.data.toString("base64")}`;
  if (IMAGE_TYPES.has(a.content_type)) return { type: "input_image", image_url: dataUrl, detail: "auto" };
  if (a.content_type === "application/pdf") return { type: "input_file", filename: `attachment-${a.id}.pdf`, file_data: dataUrl };
  if (a.content_type.startsWith("text/")) return { type: "input_text", text: `[Attached text file]\n${a.data.toString("utf8")}` };
  return { type: "input_text", text: `[Attachment of type ${a.content_type} that I can't read]` };
}

/**
 * Rebuild the model conversation from a stored transcript. `selfRole` is the
 * stored role that maps to the model's user turns ('user' for invited users,
 * 'counterpart' for third parties). Events become developer notes.
 */
export async function historyFromTranscript(
  conversationId: number,
  selfRole: "user" | "counterpart",
  limit = 40,
): Promise<InputItem[]> {
  const rows = await listMessages(conversationId, limit);
  const attachments = await attachmentsFor(rows.filter((m) => m.role === selfRole).map((m) => m.id));
  const items: InputItem[] = [];
  for (const m of rows as Message[]) {
    if (m.role === "assistant") {
      if (m.body) items.push({ role: "assistant", content: m.body });
    } else if (m.role === selfRole) {
      const files = (attachments.get(m.id) ?? []).map(attachmentPart);
      const parts: ContentPart[] = [];
      if (files.length) parts.push({ type: "input_text", text: `[Sent ${m.created_at.toISOString()} with ${files.length} attachment(s):]` }, ...files);
      parts.push({ type: "input_text", text: m.body || "(no text)" });
      items.push({ role: "user", content: parts });
    } else if (m.role === "event") {
      items.push({ role: "developer", content: `Note: ${m.body}` });
    }
  }
  while (items.length && "role" in items[0] && items[0].role === "assistant") items.shift();
  return items;
}

/** A calling user's recent web chat and files (e.g. a quote they uploaded), as model input. */
export async function recentChatContext(user: User): Promise<ContentPart[]> {
  const thread = await userChatConversation(user);
  const recent = (await listMessages(thread.id, 20)).filter((m) => m.role !== "event");
  const blocks: ContentPart[] = [];
  const files = await query<Attachment>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id = $1 AND a.created_at > now() - interval '7 days' ORDER BY a.id DESC LIMIT 3`,
    [thread.id],
  );
  if (files.length) {
    blocks.push({ type: "input_text", text: "[Files the user recently uploaded in the chat:]" });
    blocks.push(...files.map(attachmentPart));
  }
  const transcript = recent.map((m) => `${m.role === "assistant" ? "You" : "User"}: ${m.body}`).join("\n");
  blocks.push({
    type: "input_text",
    text: `${transcript ? `[Your recent chat messages with the user:]\n${transcript}\n\n` : ""}[The user is now calling you.]`,
  });
  return blocks;
}
