import { APIUserAbortError } from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { agentEndpoint, type AgentEndpoint } from "./provider.js";

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

/** One model turn, whichever API the provider speaks. */
interface Turn {
  /** Output items to append to the conversation (always valid Responses API input). */
  items: InputItem[];
  text: string[];
  calls: Array<{ call_id: string; name: string; arguments: string }>;
  refused: boolean;
  /** Stopped early (output token limit). */
  incomplete: boolean;
}

/**
 * Tool-use loop on the configured provider: the OpenAI Responses API, or
 * Chat Completions (OpenRouter and most OpenAI-compatible servers). The
 * conversation is kept as Responses API items either way. Nothing is stored
 * server-side where the API allows us to say so.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const toolsByName = new Map(opts.tools.map((t) => [t.definition.name, t]));
  const endpoint = agentEndpoint();
  const preamble: InputItem[] = opts.systemDetails ? [{ role: "developer", content: opts.systemDetails }] : [];

  const textParts: string[] = [];
  const toolCalls: string[] = [];
  const toolOutputs: string[] = [];
  try {
    for (let i = 0; i < (opts.maxIterations ?? 8); i++) {
      const input = [...preamble, ...opts.messages];
      const turn = endpoint.format === "responses" ? await responsesTurn(endpoint, opts, input) : await chatTurn(endpoint, opts, input);

      opts.messages.push(...turn.items);
      textParts.push(...turn.text);
      if (turn.refused) {
        if (!textParts.length) {
          textParts.push(REFUSAL_TEXT);
          opts.onText?.(REFUSAL_TEXT);
        }
        return { text: textParts.join("\n"), toolCalls, refused: true };
      }

      const calls = turn.calls;
      if (!calls.length || turn.incomplete) break;

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

async function responsesTurn(endpoint: AgentEndpoint, opts: RunAgentOptions, input: InputItem[]): Promise<Turn> {
  const stream = endpoint.client.responses.stream(
    {
      model: endpoint.model,
      instructions: opts.system,
      // Reasoning carried over from a Chat Completions provider can't be replayed here.
      input: input.filter((item) => !(item.type === "reasoning" && !item.encrypted_content)),
      tools: opts.tools.map((t) => toFunctionTool(t.definition)),
      ...(endpoint.reasoning ? { reasoning: { effort: opts.effort } } : {}),
      max_output_tokens: opts.maxTokens ?? 16000,
      // Keep transcripts off the provider's servers; reasoning is carried forward encrypted.
      store: false,
      ...(endpoint.reasoning ? { include: ["reasoning.encrypted_content" as const] } : {}),
      ...endpoint.extraBody,
    },
    { signal: opts.signal },
  );
  if (opts.onText) stream.on("response.output_text.delta", (event) => opts.onText!(event.delta));
  const response = await stream.finalResponse();

  const turn: Turn = { items: response.output.map(toInputItem), text: [], calls: [], refused: false, incomplete: response.status === "incomplete" };
  for (const item of response.output) {
    if (item.type === "function_call") turn.calls.push(item);
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text" && part.text.trim()) turn.text.push(part.text);
      if (part.type === "refusal") turn.refused = true;
    }
  }
  return turn;
}

async function chatTurn(endpoint: AgentEndpoint, opts: RunAgentOptions, input: InputItem[]): Promise<Turn> {
  const stream = await endpoint.client.chat.completions.create(
    {
      model: endpoint.model,
      messages: toChatMessages(opts.system, input),
      ...(opts.tools.length ? { tools: opts.tools.map((t) => toChatTool(t.definition)) } : {}),
      max_tokens: opts.maxTokens ?? 16000,
      ...chatReasoning(endpoint, opts.effort),
      ...endpoint.extraBody,
      stream: true,
    },
    { signal: opts.signal },
  );

  let text = "";
  let refusal = "";
  let finish = "";
  const slots: Array<{ id: string; name: string; arguments: string }> = [];
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) {
      text += delta.content;
      opts.onText?.(delta.content);
    }
    if (delta.refusal) refusal += delta.refusal;
    for (const call of delta.tool_calls ?? []) {
      const slot = (slots[call.index ?? 0] ??= { id: "", name: "", arguments: "" });
      if (call.id) slot.id = call.id;
      if (call.function?.name && !slot.name) slot.name = call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const turn: Turn = { items: [], text: [], calls: [], refused: !!refusal && !text.trim(), incomplete: finish === "length" };
  if (text.trim()) {
    turn.text.push(text);
    turn.items.push({ role: "assistant", content: text });
  }
  for (const [i, slot] of slots.entries()) {
    if (!slot?.name) continue;
    // Some servers leave out call ids; the model only needs them to match its own calls.
    const call = { call_id: slot.id || `call_${Date.now().toString(36)}_${i}`, name: slot.name, arguments: slot.arguments || "{}" };
    turn.calls.push(call);
    turn.items.push({ type: "function_call", ...call });
  }
  return turn;
}

/** Reasoning effort, in the shape each Chat Completions provider expects. */
function chatReasoning(endpoint: AgentEndpoint, effort: RunAgentOptions["effort"]): Record<string, unknown> {
  if (!endpoint.reasoning) return {};
  return endpoint.provider === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

function toChatTool(def: ToolDefinition): ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: { ...def.parameters, required: Object.keys(def.parameters.properties), additionalProperties: false },
    },
  };
}

/**
 * Responses API items as Chat Completions messages. Developer notes before
 * the conversation join the system prompt (some servers only accept one
 * system message, first); later ones stay system messages in place. A model
 * turn's text and tool calls become one assistant message.
 */
export function toChatMessages(system: string, items: InputItem[]): ChatCompletionMessageParam[] {
  const leading: string[] = [system];
  const out: ChatCompletionMessageParam[] = [];
  let assistant: ChatCompletionAssistantMessageParam | null = null;
  const flush = () => {
    if (assistant) out.push(assistant);
    assistant = null;
  };
  for (const item of items as any[]) {
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      assistant ??= { role: "assistant", content: null };
      (assistant.tool_calls ??= []).push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
      continue;
    }
    if (item.type === "function_call_output") {
      flush();
      out.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
      continue;
    }
    if (item.role === "assistant") {
      flush();
      assistant = { role: "assistant", content: textOf(item.content) || null };
      continue;
    }
    flush();
    if (item.role === "developer" || item.role === "system") {
      if (out.length) out.push({ role: "system", content: textOf(item.content) });
      else leading.push(textOf(item.content));
    } else if (item.role === "user") {
      out.push({ role: "user", content: typeof item.content === "string" ? item.content : item.content.map(toChatPart) });
    }
  }
  flush();
  return [{ role: "system", content: leading.filter(Boolean).join("\n\n") }, ...out];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : typeof part?.refusal === "string" ? part.refusal : ""))
    .filter(Boolean)
    .join("\n");
}

function toChatPart(part: ContentPart): ChatCompletionContentPart {
  switch (part.type) {
    case "input_text":
      return { type: "text", text: part.text };
    case "input_image":
      return { type: "image_url", image_url: { url: part.image_url ?? "", detail: part.detail === "original" ? "high" : part.detail } };
    case "input_file":
      return { type: "file", file: { filename: part.filename ?? "attachment", file_data: part.file_data ?? "" } };
    default:
      return { type: "text", text: "[An attachment this model can't read]" };
  }
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

/** Single-shot helper for summaries and quick checks. */
export async function complete(
  system: string,
  prompt: string,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const endpoint = agentEndpoint();
  const maxTokens = opts.maxTokens ?? 4000;
  if (endpoint.format === "responses") {
    const response = await endpoint.client.responses.create(
      {
        model: endpoint.model,
        instructions: system,
        input: prompt,
        ...(endpoint.reasoning ? { reasoning: { effort: "low" as const } } : {}),
        max_output_tokens: maxTokens,
        store: false,
        ...endpoint.extraBody,
      },
      { signal: opts.signal },
    );
    return response.output_text.trim();
  }
  const response = await endpoint.client.chat.completions.create(
    {
      model: endpoint.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      ...chatReasoning(endpoint, "low"),
      ...endpoint.extraBody,
    },
    { signal: opts.signal },
  );
  return (response.choices?.[0]?.message?.content ?? "").trim();
}
