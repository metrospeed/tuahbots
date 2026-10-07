import "./env.js";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { functionCall, rejectUnknown, sendResponseStream, textMessage, unknownInputField } from "./fake-openai.js";

// A fake Responses API: first turn calls a tool, second turn answers in text.
const requests: any[] = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const request = JSON.parse(body);
    requests.push(request);
    const unknown = unknownInputField(request);
    if (unknown) return rejectUnknown(res, unknown);
    sendResponseStream(
      res,
      request.model,
      requests.length === 1 ? [functionCall("lookup", { quote: "4471" })] : [textMessage("Quote 4471 is approved.")],
    );
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
