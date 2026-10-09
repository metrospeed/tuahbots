import express from "express";
import { toE164 } from "../phone.js";
import { findSentText, smsConfigured, smsPhoneNumber, verifyWebhookAuth } from "../sms.js";
import { handleInboundText, handleTextFailed } from "../texts.js";

export const httpsmsRouter = express.Router();

/**
 * Events from httpSMS (https://httpsms.com): texts the phone received, and
 * texts it couldn't send. Point an httpSMS webhook here with the signing key
 * from HTTPSMS_WEBHOOK_SIGNING_KEY.
 */
httpsmsRouter.post("/httpsms/webhook", express.json({ limit: "1mb" }), (req, res) => {
  if (!smsConfigured()) return void res.sendStatus(404);
  if (!verifyWebhookAuth(req.header("Authorization"))) {
    console.warn("Rejected an httpSMS webhook without a valid signature");
    return void res.status(401).send("Invalid signature");
  }
  // Answer right away; the agent may take longer than httpSMS waits.
  res.sendStatus(204);
  const type = String(req.header("X-Event-Type") ?? req.body?.type ?? "");
  handleEvent(type, req.body?.data ?? {}).catch((err) => console.error(`httpSMS ${type} event handling failed`, err));
});

async function handleEvent(type: string, data: Record<string, any>): Promise<void> {
  if (type === "message.phone.received") {
    // One httpSMS account can have several phones; only ours is ours.
    if (toE164(String(data.owner ?? "")) !== smsPhoneNumber()) {
      return void console.warn(`Ignored a text received by ${String(data.owner)}, which isn't HTTPSMS_PHONE_NUMBER`);
    }
    const from = toE164(String(data.contact ?? "")) ?? String(data.contact ?? "");
    const attachments = Array.isArray(data.attachments) ? data.attachments.length : 0;
    const body = data.encrypted
      ? "[Encrypted text that can't be read here. Turn off end-to-end encryption in the httpSMS app.]"
      : String(data.content ?? "") + (attachments ? ` [${attachments} attachment(s) not saved]` : "");
    return handleInboundText({ from, body, smsId: String(data.message_id ?? "") || `in-${Date.now()}` });
  }
  // Failed sends are final; expired ones are retried by the phone until is_final.
  if (type === "message.send.failed" || (type === "message.send.expired" && data.is_final !== false)) {
    const message = await findSentText(data.request_id, data.id ?? data.message_id);
    const reason = type === "message.send.failed" ? String(data.error_message ?? "") : "the phone didn't send it in time";
    if (message) await handleTextFailed(message.id, reason);
  }
}
