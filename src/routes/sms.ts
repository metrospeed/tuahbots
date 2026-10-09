import express from "express";
import { addMessage, createConversation, findActiveUserByPhone, queryOne, type Conversation } from "../db/index.js";
import { toE164 } from "../phone.js";
import { requireTwilioSignature } from "../twilio.js";

export const smsRouter = express.Router();

/**
 * The agent never texts from the Twilio number (so no A2P 10DLC registration
 * is needed; texting goes through httpSMS, see src/routes/httpsms.ts), but
 * people may still text it. Log those for the admin and don't reply.
 */
smsRouter.post("/twilio/sms", requireTwilioSignature, async (req, res) => {
  res.type("text/xml").send("<Response/>");
  try {
    const from = toE164(String(req.body.From ?? "")) ?? String(req.body.From ?? "");
    const user = await findActiveUserByPhone(from);
    const conversation =
      (await queryOne<Conversation>(
        "SELECT * FROM conversations WHERE kind = 'unknown_sms' AND counterpart_phone = $1 ORDER BY id DESC LIMIT 1",
        [from],
      )) ?? (await createConversation({ kind: "unknown_sms", userId: user?.id ?? null, counterpartPhone: from, direction: "inbound" }));
    const media = Number(req.body.NumMedia ?? 0);
    const body = String(req.body.Body ?? "") + (media ? ` [${media} attachment(s) not saved]` : "");
    await addMessage(conversation.id, user ? "user" : "counterpart", body, String(req.body.MessageSid ?? ""));
  } catch (err) {
    console.error("Inbound SMS logging failed", err);
  }
});
