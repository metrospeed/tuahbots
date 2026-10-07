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

function twilioAuth(): string {
  return `Basic ${Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString("base64")}`;
}

function recordingUrl(recordingSid: string, ext: "mp3" | "json"): string {
  return `${config.twilio.apiBaseUrl}/2010-04-01/Accounts/${config.twilio.accountSid}/Recordings/${encodeURIComponent(recordingSid)}.${ext}`;
}

/** Download a call recording (mp3) from Twilio. */
export async function fetchRecording(recordingSid: string): Promise<globalThis.Response> {
  return fetch(recordingUrl(recordingSid, "mp3"), { headers: { Authorization: twilioAuth() } });
}

/** Delete a recording from Twilio. Returns true if it's gone (including already deleted). */
export async function deleteTwilioRecording(recordingSid: string): Promise<boolean> {
  const res = await fetch(recordingUrl(recordingSid, "json"), { method: "DELETE", headers: { Authorization: twilioAuth() } });
  return res.status === 204 || res.status === 404;
}
