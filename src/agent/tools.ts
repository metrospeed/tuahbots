import { addMessage, getTask, type Task, type User } from "../db/index.js";
import {
  checkOutboundAllowed,
  describeTask,
  finishTask,
  placeTaskCall,
  recentTasks,
  visibleTask,
  startCallTask,
  startTextTask,
  TaskError,
} from "../tasks.js";
import { smsConfigured } from "../sms.js";
import { continueTextTask } from "../texts.js";
import type { AgentTool } from "./llm.js";

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
  const task = await visibleTask(user.id, Number(taskId));
  if (!task) throw new TaskError(`No task #${taskId} found for you.`);
  return task;
}

/** Tools for the agent serving an invited user (web chat or inbound call). */
export function userTools(user: User, conversationId: number, call?: CallControls): AgentTool[] {
  const logEvent = (text: string) => addMessage(conversationId, "event", text);
  const tools: AgentTool[] = [
    {
      definition: {
        name: "call_number",
        description:
          "Place a phone call to a third party on the user's behalf. A separate voice agent conducts the call using only the brief you provide, and a summary is posted to the user's chat afterwards. The call opens with an AI and recording disclosure.",
        parameters: {
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
          return `Calling now (task #${task.id}). A summary will be posted in the chat when the call ends.`;
        }),
    },
    ...(smsConfigured() ? [textNumberTool(user, logEvent)] : []),
    {
      definition: {
        name: "list_tasks",
        description: "List the user's recent call and text tasks with their status and results.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
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
          "Follow up on an earlier task with new instructions or answers from the user. For a call, places a new call to the same number with the earlier objective and result in the brief. For texts, the texting agent sends the follow-up in the same thread.",
        parameters: {
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
          if (task.kind === "sms") {
            await checkOutboundAllowed(user, task.target_phone, "sms");
            await logEvent(`Follow-up for text task #${task.id}`);
            void continueTextTask(task.id, instructions).catch((err) => console.error(`Task #${task.id} follow-up failed`, err));
            return `Following up by text (task #${task.id}). The outcome will be posted in the chat.`;
          }
          const next = await startCallTask(user, {
            phone: task.target_phone,
            recipientName: task.target_name,
            objective: instructions,
            context: `${task.context}\n\nThis is a follow-up to an earlier call. Earlier objective: ${task.objective}\nEarlier result: ${task.result || "(none)"}`,
          });
          await logEvent(`Created follow-up call task #${next.id} for task #${task.id}`);
          return `Calling again (task #${next.id}).`;
        }),
    },
    {
      definition: {
        name: "cancel_task",
        description: "Stop tracking a task, e.g. one the user no longer cares about.",
        parameters: {
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

function textNumberTool(user: User, logEvent: (text: string) => Promise<unknown>): AgentTool {
  return {
    definition: {
      name: "text_number",
      description:
        "Text a third party on the user's behalf and handle their replies. A separate agent answers their replies using only the brief you provide, and the outcome is posted to the user's chat. A footer saying you're an AI assistant texting for the user, and how to opt out, is added to the first text automatically.",
      parameters: {
        type: "object",
        properties: {
          phone: str("Phone number to text, as given by the user."),
          recipient_name: str("Person or business being texted, or empty string if unknown."),
          message: str("The first text to send: greet them, say who you're writing for, and ask clearly. Plain text, a few sentences at most."),
          objective: str("What the exchange should accomplish, in one or two sentences."),
          context: str("Self-contained brief for the agent that will answer their replies: every fact, reference number, amount and constraint it needs. It cannot see this conversation or any files."),
        },
        required: ["phone", "recipient_name", "message", "objective", "context"],
        additionalProperties: false,
      },
    },
    run: (input) =>
      guard(async () => {
        const task = await startTextTask(user, {
          phone: String(input.phone),
          recipientName: String(input.recipient_name ?? ""),
          message: String(input.message ?? ""),
          objective: String(input.objective),
          context: String(input.context ?? ""),
        });
        await logEvent(`Created text task #${task.id} to ${task.target_phone}`);
        return `Text sent (task #${task.id}). Their replies will be handled and the outcome posted in the chat.`;
      }),
  };
}

function endCallTool(call: CallControls): AgentTool {
  return {
    definition: {
      name: "end_call",
      description: "Hang up after you've said goodbye.",
      parameters: {
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
        parameters: {
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
