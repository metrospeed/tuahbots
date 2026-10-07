import { addMessage, getTask, query, type Task, type User } from "../db/index.js";
import {
  describeTask,
  finishTask,
  notifyUser,
  placeTaskCall,
  recentTasks,
  startCallTask,
  startSmsTask,
  TaskError,
} from "../tasks.js";
import type { AgentTool } from "./claude.js";

/** Hooks a live phone call provides to its agent. */
export interface CallControls {
  endCall(reason: string): void;
  pressDigits(digits: string): void;
}

const str = (description: string) => ({ type: "string", description });

async function guard(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaskError) return `Not done: ${err.message}`;
    throw err;
  }
}

async function ownTask(user: User, taskId: unknown): Promise<Task> {
  const task = await getTask(Number(taskId));
  if (!task || task.user_id !== user.id) throw new TaskError(`No task #${taskId} found for you.`);
  return task;
}

/** Tools for the agent serving an invited user (SMS or inbound call). */
export function userTools(user: User, conversationId: number, call?: CallControls): AgentTool[] {
  const logEvent = (text: string) => addMessage(conversationId, "event", text);
  const tools: AgentTool[] = [
    {
      definition: {
        name: "call_number",
        description:
          "Place a phone call to a third party on the user's behalf. A separate voice agent conducts the call using only the brief you provide, and the user is texted a summary afterwards. The call opens with an AI and recording disclosure.",
        input_schema: {
          type: "object",
          properties: {
            phone: str("Phone number to call, as given by the user."),
            recipient_name: str("Person or business being called, or empty string if unknown."),
            objective: str("What the call should accomplish, in one or two sentences."),
            context: str("Self-contained brief for the calling agent: every fact, reference number, amount and constraint it needs. It cannot see this conversation or any files."),
          },
          required: ["phone", "recipient_name", "objective", "context"],
          additionalProperties: false,
        },
      },
      run: (input) =>
        guard(async () => {
          const task = await startCallTask(user, {
            phone: String(input.phone),
            recipientName: String(input.recipient_name ?? ""),
            objective: String(input.objective),
            context: String(input.context ?? ""),
          });
          await logEvent(`Created call task #${task.id} to ${task.target_phone}`);
          return `Calling now (task #${task.id}). The user will be texted a summary when the call ends.`;
        }),
    },
    {
      definition: {
        name: "text_number",
        description:
          "Send a text message to a third party on the user's behalf and handle their replies. A footer identifying you as an AI assistant for the user, with opt-out instructions, is appended automatically. The user is texted the outcome.",
        input_schema: {
          type: "object",
          properties: {
            phone: str("Phone number to text, as given by the user."),
            recipient_name: str("Person or business being texted, or empty string if unknown."),
            message: str("The first text to send. Greet them, say who you are writing for, and ask clearly."),
            objective: str("What the exchange should accomplish."),
            context: str("Self-contained brief for the agent that will handle replies: all facts it needs. It cannot see this conversation or any files."),
          },
          required: ["phone", "recipient_name", "message", "objective", "context"],
          additionalProperties: false,
        },
      },
      run: (input) =>
        guard(async () => {
          const task = await startSmsTask(user, {
            phone: String(input.phone),
            recipientName: String(input.recipient_name ?? ""),
            message: String(input.message),
            objective: String(input.objective),
            context: String(input.context ?? ""),
          });
          await logEvent(`Created text task #${task.id} to ${task.target_phone}`);
          return `Text sent (task #${task.id}). Replies will be handled and the user texted the outcome.`;
        }),
    },
    {
      definition: {
        name: "list_tasks",
        description: "List the user's recent call and text tasks with their status and results.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      run: async () => {
        const tasks = await recentTasks(user.id);
        return tasks.length ? tasks.map(describeTask).join("\n\n") : "No tasks yet.";
      },
    },
    {
      definition: {
        name: "followup_task",
        description:
          "Follow up on an earlier task with new instructions or answers from the user. For a text task, the reply agent sends the follow-up in the same thread. For a call task, a new call is placed to the same number.",
        input_schema: {
          type: "object",
          properties: {
            task_id: { type: "integer", description: "The task number." },
            instructions: str("What to say or ask now, including any answers the user gave."),
          },
          required: ["task_id", "instructions"],
          additionalProperties: false,
        },
      },
      run: (input) =>
        guard(async () => {
          const task = await ownTask(user, input.task_id);
          const instructions = String(input.instructions);
          if (task.kind === "call") {
            const next = await startCallTask(user, {
              phone: task.target_phone,
              recipientName: task.target_name,
              objective: instructions,
              context: `${task.context}\n\nThis is a follow-up to an earlier call. Earlier objective: ${task.objective}\nEarlier result: ${task.result || "(none)"}`,
            });
            await logEvent(`Created follow-up call task #${next.id} for task #${task.id}`);
            return `Calling again (task #${next.id}).`;
          }
          const { continueSmsTask } = await import("../routes/sms.js");
          await query(
            "UPDATE tasks SET status = 'in_progress', completed_at = NULL, context = context || $2 WHERE id = $1",
            [task.id, `\n\nFollow-up from the requester: ${instructions}`],
          );
          await continueSmsTask(task.id, `The requester sent follow-up instructions: ${instructions}\nSend the appropriate text to the other party now.`);
          return `Follow-up sent for task #${task.id}.`;
        }),
    },
    {
      definition: {
        name: "cancel_task",
        description: "Stop working on a task. Replies from that number will no longer be handled.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer", description: "The task number." } },
          required: ["task_id"],
          additionalProperties: false,
        },
      },
      run: (input) =>
        guard(async () => {
          const task = await ownTask(user, input.task_id);
          await finishTask(task.id, "cancelled", "Cancelled by the requester.");
          return `Task #${task.id} cancelled.`;
        }),
    },
  ];
  if (call) tools.push(endCallTool(call));
  return tools;
}

function endCallTool(call: CallControls): AgentTool {
  return {
    definition: {
      name: "end_call",
      description: "Hang up after you've said goodbye.",
      input_schema: {
        type: "object",
        properties: { reason: str("Why the call is ending.") },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      call.endCall(String(input.reason));
      return "Call ending.";
    },
  };
}

/** Tools for the agent on a call with a third party. */
export function taskCallTools(call: CallControls): AgentTool[] {
  return [
    endCallTool(call),
    {
      definition: {
        name: "press_digits",
        description: "Press keypad digits to navigate a phone menu. Allowed characters: 0-9, *, #, and w (half-second pause).",
        input_schema: {
          type: "object",
          properties: { digits: str("Digits to press, e.g. \"2\" or \"1w2#\".") },
          required: ["digits"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        const digits = String(input.digits);
        if (!/^[0-9*#w]{1,32}$/.test(digits)) return "Invalid digits.";
        call.pressDigits(digits);
        return `Pressed ${digits}.`;
      },
    },
  ];
}

/** Tools for the agent texting with a third party. */
export function taskSmsTools(task: Task, user: User, conversationId: number): AgentTool[] {
  return [
    {
      definition: {
        name: "complete_task",
        description: "Finish the task and text the requester your summary of the outcome.",
        input_schema: {
          type: "object",
          properties: { result: str("Concise, complete summary of what was learned or agreed, with exact figures and dates.") },
          required: ["result"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        await finishTask(task.id, "completed", String(input.result));
        await addMessage(conversationId, "event", `Task #${task.id} completed`);
        return "Task completed and requester notified.";
      },
    },
    {
      definition: {
        name: "message_requester",
        description: "Text the requester a question or update, e.g. when the other party asks something only the requester can answer.",
        input_schema: {
          type: "object",
          properties: { message: str("The message to the requester.") },
          required: ["message"],
          additionalProperties: false,
        },
      },
      run: async (input) => {
        await notifyUser(user, `Re task #${task.id} (${task.target_name || task.target_phone}): ${String(input.message)}`);
        await addMessage(conversationId, "event", `Messaged requester: ${String(input.message)}`);
        return "Sent to the requester. Their answer will arrive as a follow-up.";
      },
    },
  ];
}
