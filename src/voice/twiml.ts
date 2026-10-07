import twilio from "twilio";
import { config } from "../config.js";

export function relayUrl(token: string): string {
  return `${config.publicBaseUrl.replace(/^http/, "ws")}/twilio/relay?token=${encodeURIComponent(token)}`;
}

/**
 * Connect the call to our websocket via Twilio ConversationRelay, which does
 * speech-to-text and text-to-speech. The greeting (with the recording
 * disclosure) is spoken by Twilio before anything else and cannot be interrupted.
 */
export function buildRelayTwiml(token: string, greeting: string): string {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect({ action: `${config.publicBaseUrl}/twilio/voice/relay-ended` });
  connect.conversationRelay({
    url: relayUrl(token),
    welcomeGreeting: greeting,
    welcomeGreetingInterruptible: "none",
    interruptible: "speech",
    dtmfDetection: true,
    ...(config.twilio.ttsVoice ? { voice: config.twilio.ttsVoice } : {}),
  });
  return response.toString();
}

export function sayAndHangup(text: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(text);
  response.hangup();
  return response.toString();
}
