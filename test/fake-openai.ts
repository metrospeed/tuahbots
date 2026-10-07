import type http from "node:http";

/** Stream a Responses API result as server-sent events, the way the real API does. */
export function sendResponseStream(res: http.ServerResponse, model: string, output: any[], id = "resp_test"): void {
  const response = { id, object: "response", created_at: 0, status: "completed", model, output, error: null, incomplete_details: null };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let seq = 0;
  const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`);
  send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  output.forEach((item, i) => {
    send({ type: "response.output_item.added", output_index: i, item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
    if (item.type === "message") {
      const text = item.content[0].text;
      send({ type: "response.content_part.added", item_id: item.id, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send({ type: "response.output_text.delta", item_id: item.id, output_index: i, content_index: 0, delta: text, logprobs: [] });
      send({ type: "response.output_text.done", item_id: item.id, output_index: i, content_index: 0, text, logprobs: [] });
    } else {
      send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: i, delta: item.arguments });
      send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: i, arguments: item.arguments, name: item.name });
    }
    send({ type: "response.output_item.done", output_index: i, item });
  });
  send({ type: "response.completed", response });
  res.end();
}

export const functionCall = (name: string, args: object, callId = "call_1") => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status: "completed",
});

export const textMessage = (text: string) => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
