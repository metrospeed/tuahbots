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
    // With the greeting switched off (testing), the agent answers the first thing said.
    ...(greeting ? { welcomeGreeting: greeting, welcomeGreetingInterruptible: "none" as const } : {}),
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

/**
 * GPT-Live calls: play the recording/AI disclosure with <Say> (so it is always
 * spoken verbatim), then stream call audio to our websocket. Twilio does not
 * allow query strings on stream URLs, so the token goes in a <Parameter>.
 */
export function buildStreamTwiml(token: string, greeting: string): string {
  const response = new twilio.twiml.VoiceResponse();
  // Skipped only when the admin switched this greeting off for testing.
  if (greeting) response.say({ voice: config.voice.disclosureVoice as any }, greeting);
  const connect = response.connect({ action: `${config.publicBaseUrl}/twilio/voice/relay-ended` });
  const stream = connect.stream({ url: `${config.publicBaseUrl.replace(/^http/, "ws")}/twilio/stream` });
  stream.parameter({ name: "token", value: token });
  return response.toString();
}

/** TwiML that connects a call to whichever voice engine is configured. */
export function buildCallTwiml(token: string, greeting: string): string {
  return config.voice.engine === "gpt-live" ? buildStreamTwiml(token, greeting) : buildRelayTwiml(token, greeting);
}
