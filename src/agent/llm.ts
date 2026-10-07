import OpenAI, { APIUserAbortError } from "openai";
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { config } from "../config.js";

export const openai = new OpenAI();

export type InputItem = ResponseInputItem;
export type ContentPart = ResponseInputContent;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Every property is treated as required (strict mode). */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
    additionalProperties?: false;
  };
}

export interface AgentTool {
  definition: ToolDefinition;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface RunAgentOptions {
  system: string;
  /** Per-conversation details, sent as a developer message after the stable instructions. */
  systemDetails?: string;
  /** Conversation so far. Mutated: each turn's output and tool results are appended. */
  messages: InputItem[];
  tools: AgentTool[];
  effort: "low" | "medium" | "high";
  maxTokens?: number;
  /** Called with each streamed text fragment (used to speak while generating on calls). */
  onText?: (delta: string) => void;
  /** Called between model turns when a tool batch is about to run. */
  onToolStart?: () => void;
  signal?: AbortSignal;
  maxIterations?: number;
}

export interface RunAgentResult {
  /** Text the agent produced across all turns of this run, in order. */
  text: string;
  /** Names of tools the agent called, in order. */
  toolCalls: string[];
  refused: boolean;
}

const REFUSAL_TEXT = "Sorry, I can't help with that request.";

/**
 * A model request failed partway through a run. `toolOutputs` lists what the
 * tools already did (e.g. a call was placed), so callers can report that
 * instead of claiming nothing happened.
 */
export class AgentRunError extends Error {
  constructor(
    readonly cause: unknown,
    readonly toolCalls: string[],
    readonly toolOutputs: string[],
  ) {
    super(`Agent run failed after ${toolCalls.length} tool call(s): ${(cause as Error)?.message ?? cause}`);
  }
}

function toFunctionTool(def: ToolDefinition): FunctionTool {
  return {
    type: "function",
    name: def.name,
    description: def.description,
    strict: true,
    parameters: { ...def.parameters, required: Object.keys(def.parameters.properties), additionalProperties: false },
  };
}

/** Tool-use loop on the OpenAI Responses API. Nothing is stored server-side. */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const toolsByName = new Map(opts.tools.map((t) => [t.definition.name, t]));
  const tools = opts.tools.map((t) => toFunctionTool(t.definition));
  const preamble: InputItem[] = opts.systemDetails ? [{ role: "developer", content: opts.systemDetails }] : [];

  const textParts: string[] = [];
  const toolCalls: string[] = [];
  const toolOutputs: string[] = [];
  try {
    for (let i = 0; i < (opts.maxIterations ?? 8); i++) {
      const stream = openai.responses.stream(
        {
          model: config.agent.model,
          instructions: opts.system,
          input: [...preamble, ...opts.messages],
          tools,
          reasoning: { effort: opts.effort },
          max_output_tokens: opts.maxTokens ?? 16000,
          // Keep transcripts off OpenAI's servers; reasoning is carried forward encrypted.
          store: false,
          include: ["reasoning.encrypted_content"],
        },
        { signal: opts.signal },
      );
      if (opts.onText) stream.on("response.output_text.delta", (event) => opts.onText!(event.delta));
      const response = await stream.finalResponse();

      opts.messages.push(...response.output.map(toInputItem));
      let refused = false;
      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
          if (part.type === "output_text" && part.text.trim()) textParts.push(part.text);
          if (part.type === "refusal") refused = true;
        }
      }
      if (refused) {
        if (!textParts.length) {
          textParts.push(REFUSAL_TEXT);
          opts.onText?.(REFUSAL_TEXT);
        }
        return { text: textParts.join("\n"), toolCalls, refused: true };
      }

      const calls = response.output.filter((item) => item.type === "function_call");
      if (!calls.length || response.status === "incomplete") break;

      opts.onToolStart?.();
      const results = await Promise.all(
        calls.map(async (call): Promise<InputItem> => {
          toolCalls.push(call.name);
          const output = (text: string): InputItem => ({ type: "function_call_output", call_id: call.call_id, output: text });
          const tool = toolsByName.get(call.name);
          if (!tool) return output(`Error: unknown tool ${call.name}`);
          let input: unknown;
          try {
            input = JSON.parse(call.arguments || "{}");
          } catch {
            return output("Error: arguments were not valid JSON");
          }
          const problem = validateInput(tool.definition, input);
          if (problem) return output(`Error: ${problem}`);
          try {
            const result = await tool.run(input as Record<string, unknown>);
            toolOutputs.push(result);
            return output(result);
          } catch (err) {
            console.error(`Tool ${call.name} failed`, err);
            return output(`Error: ${(err as Error).message}`);
          }
        }),
      );
      opts.messages.push(...results);
    }
  } catch (err) {
    if (toolOutputs.length && !(err instanceof APIUserAbortError)) throw new AgentRunError(err, toolCalls, toolOutputs);
    throw err;
  }

  return { text: textParts.join("\n").trim(), toolCalls, refused: false };
}

/**
 * Turn a response output item back into an input item for the next turn. The
 * SDK's stream helper adds parsing fields (`parsed_arguments` on tool calls,
 * `parsed` on text parts) that the API rejects as unknown parameters.
 */
export function toInputItem(item: unknown): InputItem {
  const { parsed_arguments: _args, ...rest } = item as Record<string, unknown>;
  if (Array.isArray(rest.content)) {
    rest.content = rest.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const { parsed: _parsed, ...cleanPart } = part as Record<string, unknown>;
      return cleanPart;
    });
  }
  return rest as unknown as InputItem;
}

/** Defense in depth on top of strict mode: check required fields and primitive types. */
export function validateInput(tool: ToolDefinition, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "tool input must be a JSON object";
  const record = input as Record<string, unknown>;
  for (const key of tool.parameters.required ?? Object.keys(tool.parameters.properties)) {
    if (record[key] === undefined || record[key] === null) return `Missing required field "${key}"`;
  }
  for (const [key, value] of Object.entries(record)) {
    const expected = tool.parameters.properties[key]?.type;
    if (!expected || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const ok = expected === "integer" ? Number.isInteger(value) : expected === actual;
    if (!ok) return `Field "${key}" must be of type ${expected}`;
  }
  return null;
}

/** Single-shot helper for summaries. */
export async function complete(system: string, prompt: string): Promise<string> {
  const response = await openai.responses.create({
    model: config.agent.model,
    instructions: system,
    input: prompt,
    reasoning: { effort: "low" },
    max_output_tokens: 4000,
    store: false,
  });
  return response.output_text.trim();
}
