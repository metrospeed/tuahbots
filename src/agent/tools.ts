import { addMessage, getTask, type Task, type User } from "../db/index.js";
import {
  describeTask,
  finishTask,
  placeTaskCall,
  recentTasks,
  visibleTask,
  startCallTask,
  TaskError,
} from "../tasks.js";
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
    {
      definition: {
        name: "list_tasks",
        description: "List the user's recent call tasks with their status and results.",
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
          "Follow up on an earlier call with new instructions or answers from the user. Places a new call to the same number, with the earlier objective and result in the brief.",
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
