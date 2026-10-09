import { AgentRunError, runAgent } from "../agent/llm.js";
import { historyFromTranscript, userDetails } from "../agent/context.js";
import { loadPromptOverrides, USER_ASSISTANT_PROMPT } from "../agent/prompts.js";
import { userTools } from "../agent/tools.js";
import { loadAiSettings, redact } from "../agent/provider.js";
import { addMessage, pool, queryOne, type User } from "../db/index.js";
import { withLock } from "../lock.js";
import { sendTextMessage } from "../sms.js";
import { repliesByText, userChatConversation } from "../tasks.js";

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

/**
 * Store a chat message from a user, then have the agent answer it in the
 * background. `viaText` marks a text the user sent the agent's phone; the
 * reply is then texted back.
 */
export async function postUserMessage(
  user: User,
  text: string,
  uploads: Upload[],
  viaText?: { smsId: string; answer?: boolean },
): Promise<void> {
  const conversation = await userChatConversation(user);
  const message = await addMessage(conversation.id, "user", text, undefined, viaText ? { smsId: viaText.smsId } : undefined);
  for (const upload of uploads) {
    await pool.query("INSERT INTO attachments (message_id, content_type, data) VALUES ($1, $2, $3)", [
      message.id,
      upload.contentType,
      upload.data,
    ]);
  }
  if (viaText?.answer === false) return;
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
  const byText = await repliesByText(user, conversationId);
  const reply = async (body: string) => {
    if (!byText) return void (await addMessage(conversationId, "assistant", body));
    const conversation = await userChatConversation(user);
    await sendTextMessage(conversation, user.phone!, body).catch((err) => console.error("Texting the user failed", err));
  };
  try {
    await loadPromptOverrides();
    await loadAiSettings();
    const details = await userDetails(user);
    const result = await runAgent({
      system: USER_ASSISTANT_PROMPT,
      systemDetails: byText
        ? `${details}\n\nThe user's latest message came by text message, so your reply will be texted to them: keep it short and in plain text.`
        : details,
      messages: await historyFromTranscript(conversationId, "user"),
      tools: userTools(user, conversationId),
      effort: "medium",
    });
    if (result.text) await reply(result.text);
  } catch (err) {
    const cause = err instanceof AgentRunError ? err.cause : err;
    console.error("Chat agent failed", redact((cause as Error)?.stack ?? String(cause)));
    // If tools already ran (e.g. a call was placed), say what happened rather than "nothing worked".
    const done = err instanceof AgentRunError ? err.toolOutputs.filter((o) => !o.startsWith("Error:")) : [];
    await reply(done.length ? done.join("\n") : "Sorry, something went wrong on my end. Please try again in a minute.");
  }
}
