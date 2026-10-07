import { runAgent } from "../agent/llm.js";
import { historyFromTranscript, userDetails } from "../agent/context.js";
import { USER_ASSISTANT_PROMPT } from "../agent/prompts.js";
import { userTools } from "../agent/tools.js";
import { addMessage, pool, queryOne, type User } from "../db/index.js";
import { withLock } from "../lock.js";
import { userChatConversation } from "../tasks.js";

export const ALLOWED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain"]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOADS_PER_MESSAGE = 3;

/** Messages per user the agent is still answering, for the "typing" indicator. */
const pending = new Map<number, number>();
export const isBusy = (userId: number) => (pending.get(userId) ?? 0) > 0;

export interface Upload {
  contentType: string;
  data: Buffer;
}

/** Store a chat message from a user, then have the agent answer it in the background. */
export async function postUserMessage(user: User, text: string, uploads: Upload[]): Promise<void> {
  const conversation = await userChatConversation(user);
  const message = await addMessage(conversation.id, "user", text);
  for (const upload of uploads) {
    await pool.query("INSERT INTO attachments (message_id, content_type, data) VALUES ($1, $2, $3)", [
      message.id,
      upload.contentType,
      upload.data,
    ]);
  }
  pending.set(user.id, (pending.get(user.id) ?? 0) + 1);
  void withLock(`user:${user.id}`, () => answer(user, conversation.id)).finally(() => {
    const left = (pending.get(user.id) ?? 1) - 1;
    if (left > 0) pending.set(user.id, left);
    else pending.delete(user.id);
  });
}

async function answer(user: User, conversationId: number): Promise<void> {
  // A burst of messages is answered once: an earlier run may already have seen this one.
  const last = await queryOne<{ role: string }>(
    "SELECT role FROM messages WHERE conversation_id = $1 AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 1",
    [conversationId],
  );
  if (last?.role !== "user") return;
  try {
    const result = await runAgent({
      system: USER_ASSISTANT_PROMPT,
      systemDetails: await userDetails(user),
      messages: await historyFromTranscript(conversationId, "user"),
      tools: userTools(user, conversationId),
      effort: "medium",
    });
    if (result.text) await addMessage(conversationId, "assistant", result.text);
  } catch (err) {
    console.error("Chat agent failed", err);
    await addMessage(conversationId, "assistant", "Sorry, something went wrong on my end. Please try again in a minute.");
  }
}
