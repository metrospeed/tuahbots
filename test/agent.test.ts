import "./env.js";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

// A fake Responses API: first turn calls a tool, second turn answers in text.
const requests: any[] = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const request = JSON.parse(body);
    requests.push(request);
    const toolTurn = requests.length === 1;
    const output = toolTurn
      ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: JSON.stringify({ quote: "4471" }), status: "completed" }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Quote 4471 is approved.", annotations: [] }] }];
    const response = { id: `resp_${requests.length}`, object: "response", created_at: 0, status: "completed", model: request.model, output, error: null, incomplete_details: null };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (event: object) => res.write(`event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } });
    output.forEach((item, i) => {
      send({ type: "response.output_item.added", sequence_number: 1, output_index: i, item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
      if (item.type === "message") {
        send({ type: "response.content_part.added", sequence_number: 2, item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        send({ type: "response.output_text.delta", sequence_number: 3, item_id: item.id, output_index: i, content_index: 0, delta: "Quote 4471 is approved.", logprobs: [] });
        send({ type: "response.output_text.done", sequence_number: 4, item_id: item.id, output_index: i, content_index: 0, text: "Quote 4471 is approved.", logprobs: [] });
      } else {
        send({ type: "response.function_call_arguments.delta", sequence_number: 2, item_id: item.id, output_index: i, delta: item.arguments });
        send({ type: "response.function_call_arguments.done", sequence_number: 3, item_id: item.id, output_index: i, arguments: item.arguments, name: item.name });
      }
      send({ type: "response.output_item.done", sequence_number: 5, output_index: i, item });
    });
    send({ type: "response.completed", sequence_number: 6, response });
    res.end();
  });
});
await new Promise<void>((resolve) => fake.listen(0, resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
const { runAgent } = await import("../src/agent/llm.js");

after(() => fake.close());

test("runAgent runs tools and returns the final answer via the Responses API", async () => {
  const seen: unknown[] = [];
  const streamed: string[] = [];
  const messages: any[] = [{ role: "user", content: "What's the status of quote 4471?" }];
  const result = await runAgent({
    system: "You are a test agent.",
    systemDetails: "Details for this user.",
    messages,
    effort: "low",
    onText: (d) => streamed.push(d),
    tools: [
      {
        definition: {
          name: "lookup",
          description: "Look up a quote",
          parameters: { type: "object", properties: { quote: { type: "string", description: "Quote number" } } },
        },
        run: async (input) => {
          seen.push(input);
          return "approved at $8,450";
        },
      },
    ],
  });

  assert.equal(result.text, "Quote 4471 is approved.");
  assert.deepEqual(result.toolCalls, ["lookup"]);
  assert.deepEqual(seen, [{ quote: "4471" }]);
  assert.deepEqual(streamed, ["Quote 4471 is approved."]);

  const first = requests[0];
  assert.equal(first.model, "gpt-6-luna");
  assert.equal(first.store, false);
  assert.deepEqual(first.reasoning, { effort: "low" });
  assert.equal(first.instructions, "You are a test agent.");
  assert.deepEqual(first.input[0], { role: "developer", content: "Details for this user." });
  assert.equal(first.tools[0].strict, true);
  assert.deepEqual(first.tools[0].parameters.required, ["quote"]);
  assert.equal(first.tools[0].parameters.additionalProperties, false);

  // The tool result is sent back on the second turn, after the model's call.
  const second = requests[1].input;
  const call = second.find((i: any) => i.type === "function_call");
  const output = second.find((i: any) => i.type === "function_call_output");
  assert.equal(call.call_id, "call_1");
  assert.deepEqual(output, { type: "function_call_output", call_id: "call_1", output: "approved at $8,450" });
});
