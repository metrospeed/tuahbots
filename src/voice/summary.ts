import { complete } from "../agent/claude.js";
import { CALL_SUMMARY_PROMPT } from "../agent/prompts.js";
import { getTask, listMessages, query, queryOne, type Conversation } from "../db/index.js";
import { withLock } from "../lock.js";
import { finishTask } from "../tasks.js";

/**
 * Summarize a finished call once, store it, and for task calls report to the
 * requester. Safe to call from both the websocket close and status callbacks.
 */
export function finalizeCall(conversationId: number): Promise<void> {
  return withLock(`call:${conversationId}`, async () => {
    const conversation = await queryOne<Conversation>("SELECT * FROM conversations WHERE id = $1", [conversationId]);
    if (!conversation || conversation.summary) return;
    await query(
      `UPDATE conversations SET ended_at = COALESCE(ended_at, now()),
         call_status = CASE WHEN call_status = 'in-progress' THEN 'completed' ELSE call_status END
       WHERE id = $1`,
      [conversationId],
    );

    const lines = (await listMessages(conversationId)).filter((m) => m.role !== "event");
    const heard = lines.some((m) => m.role === "user" || m.role === "counterpart");
    const task = conversation.task_id ? await getTask(conversation.task_id) : undefined;

    let summary: string;
    if (!heard) {
      summary = "The call connected but the other side never spoke (possibly a hang-up or an unanswered voicemail).";
    } else {
      const transcript = lines
        .map((m) => `${m.role === "assistant" ? "AI assistant" : conversation.kind === "user_call" ? "User" : "Other party"}: ${m.body}`)
        .join("\n");
      const header = task ? `Objective of the call: ${task.objective}\n\n` : "This was a call between a user and their AI assistant.\n\n";
      summary = (await complete(CALL_SUMMARY_PROMPT, `${header}Transcript:\n${transcript}`)) || "Call finished; no summary available.";
    }
    await query("UPDATE conversations SET summary = $2 WHERE id = $1", [conversationId, summary]);
    if (task && conversation.kind === "task_call") await finishTask(task.id, heard ? "completed" : "failed", summary);
  });
}
