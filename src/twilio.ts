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

/** SMS bodies over this length are split by us so each part stays readable. */
const MAX_SMS_CHARS = 1500;

export async function sendSms(to: string, body: string): Promise<string[]> {
  const sids: string[] = [];
  for (const part of splitMessage(body, MAX_SMS_CHARS)) {
    const message = await twilioClient.messages.create({
      to,
      from: config.twilio.phoneNumber,
      body: part,
      statusCallback: `${config.publicBaseUrl}/twilio/sms/status`,
    });
    sids.push(message.sid);
  }
  return sids;
}

export function splitMessage(body: string, max: number): string[] {
  const parts: string[] = [];
  let rest = body.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Download MMS media; Twilio media URLs require account credentials. */
export async function fetchMedia(url: string): Promise<{ contentType: string; data: Buffer }> {
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
  const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, redirect: "follow" });
  if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
  return {
    contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0],
    data: Buffer.from(await response.arrayBuffer()),
  };
}

/** Stream a call recording (mp3) from Twilio. */
export async function fetchRecording(recordingSid: string): Promise<globalThis.Response> {
  const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Recordings/${recordingSid}.mp3`;
  return fetch(url, { headers: { Authorization: `Basic ${auth}` } });
}
