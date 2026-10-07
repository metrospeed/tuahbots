import type { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import { config } from "./config.js";

export const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

/** Express middleware rejecting webhook requests that are not signed by Twilio. */
export function requireTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  if (!config.twilio.validateSignatures) return next();
  const signature = req.header("X-Twilio-Signature") ?? "";
  const url = config.publicBaseUrl + req.originalUrl;
  if (twilio.validateRequest(config.twilio.authToken, signature, url, req.body ?? {})) return next();
  console.warn(`Rejected unsigned Twilio request to ${req.originalUrl}`);
  res.status(403).send("Invalid Twilio signature");
}

/** Stream a call recording (mp3) from Twilio. */
export async function fetchRecording(recordingSid: string): Promise<globalThis.Response> {
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Recordings/${recordingSid}.mp3`;
  return fetch(url, { headers: { Authorization: `Basic ${auth}` } });
}
