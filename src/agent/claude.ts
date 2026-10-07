import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../config.js";

export const anthropic = new Anthropic();

export interface AgentTool {
  definition: BetaTool;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface RunAgentOptions {
  system: string;
  /** Per-conversation details appended after the cached system prompt. */
  systemDetails?: string;
  messages: BetaMessageParam[];
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
 * Manual tool-use loop. `messages` is mutated: each assistant turn and tool
 * result batch is appended so callers can keep the conversation going.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const toolsByName = new Map(opts.tools.map((t) => [t.definition.name, t]));
  const toolDefs = opts.tools.map((t) => ({ ...t.definition, eager_input_streaming: true }));
  const system: Array<{ type: "text"; text: string }> = [{ type: "text", text: opts.system }];
  if (opts.systemDetails) system.push({ type: "text", text: opts.systemDetails });

  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (let i = 0; i < (opts.maxIterations ?? 8); i++) {
    const stream = anthropic.beta.messages.stream(
      {
        model: config.anthropic.model,
        max_tokens: opts.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort },
        cache_control: { type: "ephemeral" },
        system,
        tools: toolDefs,
        messages: opts.messages,
      },
      { signal: opts.signal },
    );
    if (opts.onText) stream.on("text", (delta) => opts.onText!(delta));
    const message = await stream.finalMessage();

    opts.messages.push({ role: "assistant", content: message.content as BetaContentBlockParam[] });
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) textParts.push(block.text);
    }

    if (message.stop_reason === "refusal") {
      console.warn("Agent request refused", message.stop_details);
      if (!textParts.length) {
        textParts.push(REFUSAL_TEXT);
        opts.onText?.(REFUSAL_TEXT);
      }
      return { text: textParts.join("\n"), toolCalls, refused: true };
    }
    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason !== "tool_use") break;

    opts.onToolStart?.();
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    const results: BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (use): Promise<BetaToolResultBlockParam> => {
        toolCalls.push(use.name);
        const tool = toolsByName.get(use.name);
        const input = use.input as Record<string, unknown>;
        const problem = tool ? validateInput(tool.definition, input) : `Unknown tool ${use.name}`;
        if (problem) return { type: "tool_result", tool_use_id: use.id, content: problem, is_error: true };
        try {
          return { type: "tool_result", tool_use_id: use.id, content: await tool!.run(input) };
        } catch (err) {
          console.error(`Tool ${use.name} failed`, err);
          return { type: "tool_result", tool_use_id: use.id, content: `Error: ${(err as Error).message}`, is_error: true };
        }
      }),
    );
    opts.messages.push({ role: "user", content: results });
  }

  return { text: textParts.join("\n").trim(), toolCalls, refused: false };
}

/**
 * Inputs stream eagerly, so the API does not validate them against the schema;
 * check required fields and primitive types before running a tool.
 */
export function validateInput(tool: BetaTool, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "INVALID_JSON: tool input must be a JSON object";
  }
  const schema = tool.input_schema;
  const record = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined || record[key] === null) return `Missing required field "${key}"`;
  }
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const [key, value] of Object.entries(record)) {
    const expected = properties[key]?.type;
    if (!expected || value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const ok = expected === "integer" ? Number.isInteger(value) : expected === actual;
    if (!ok) return `Field "${key}" must be of type ${expected}`;
  }
  return null;
}

/** Single-shot helper for summaries. */
export async function complete(system: string, prompt: string): Promise<string> {
  const message = await anthropic.beta.messages
    .stream({
      model: config.anthropic.model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: prompt }],
    })
    .finalMessage();
  if (message.stop_reason === "refusal") return "";
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
