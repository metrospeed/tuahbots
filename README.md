# tuahbots

An invite-only AI phone agent. People you invite chat with it on a private web page and ask it to phone someone for them, for example:

> "Call (555) 123-4567, that's Mike at Acme Roofing. Get the status of the quote I just sent you and ask if they can start before the 20th."

The agent reads the photo or PDF of the quote the user uploaded, calls Mike with a brief built from it, opens the call by saying it's an AI assistant and that **the call is recorded**, has the conversation, then posts a summary in the user's chat. Every chat, call transcript, and recording shows up in an admin panel.

**The app never sends text messages**, so you don't need A2P 10DLC registration.

## How it works

```
Invited user ──web chat (/app)──────────────────────► app (Node/TS) ──► Claude (chat, tools)
  (optional) ──call──► Twilio number ──webhooks──────►  │  ▲
Third party ◄──call────────────────◄── Twilio REST ─────┘  │ delegated tasks
                                                         │  │
                    call audio (μ-law) ◄──Media Streams──►  app ◄──► OpenAI GPT-Live (voice)
                                                         │
                                       Postgres ◄────────┘──► /admin panel
```

- **Web chat**: the admin invites someone and gets a private link (`/join/…`) to send them however they like. Opening it signs them in on that device for 180 days. At `/app` they chat with the agent, attach photos or PDFs (like a quote), and see their calls with status, summary, transcript, and recording. While the page is open, the browser can show a notification when a call finishes. Making a new link signs them out everywhere.
- **Calling in (optional)**: if you add a user's phone number, they can also call the Twilio number and talk to the agent. Texts to the number are logged in the admin panel and never answered.
- **Voice (GPT-Live)**: on every call, the caller's audio streams over [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) (`/twilio/stream`) to OpenAI's `gpt-live-1`. It's a full-duplex speech model: it listens while it talks and handles interruptions and "mhmm"s naturally. Twilio and GPT-Live both use 8 kHz μ-law audio, so nothing is converted. GPT-Live handles the conversation itself. When it needs something done (place a call, check a task, press keypad digits in a phone menu, hang up), it delegates the task. Claude then runs the same tools the chat agent uses, seeing the live transcript plus any files the user uploaded, and hands back a short result for GPT-Live to say. Transcripts are saved line by line as the call goes.
  - Prefer the old pipeline? Set `VOICE_ENGINE=claude-relay` to use [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay) speech-to-text and text-to-speech with Claude speaking directly.
- **Tasks**: the chat agent has tools: `call_number`, `list_tasks`, `followup_task` (calls again with new instructions), `cancel_task`. Each call is handled by an agent that only sees a written brief, not the user's whole history. It can press keypad digits for phone menus and leave voicemails. If the person calls back within 30 days, the agent picks up with the same brief. When a call ends, the summary is posted in the requester's chat.
- **Disclosure**: every call starts with a greeting Twilio speaks word for word before the AI joins (a fixed `<Say>`, so the model can't skip or reword it), e.g. *"Hi Mike, this is Tuah, an AI assistant calling on behalf of Pat. This call is being recorded and transcribed."*
- **Recording**: outbound calls are recorded from the moment they're answered, and inbound calls as soon as the agent connects. You can play recordings in the admin panel, which streams them from Twilio.
- **Admin panel** (`/admin`, password login): transcripts (searchable, with audio, attachments, and AI summaries), tasks, invited users (invite links, optional phone number, per-user notes for the agent), and blocked numbers.

### Guardrails built in
- Only invited, active users can use the agent. Invite links are stored hashed, sessions are signed cookies, and disabling a user signs them out everywhere. Everyone else gets nothing.
- You can block numbers in the admin panel. The agent will never call them.
- Calls to third parties are limited to set hours (default 8am–9pm), allowed countries (default US/CA), and a daily cap per user. Calls have a time limit. Emergency and short-code numbers can't be dialed.
- Twilio webhook signatures are checked. The voice websocket only accepts a single-use token minted for that call.
- The agent's instructions forbid harassment, marketing calls, impersonating the user, making commitments, or agreeing to payments.

## Deploy on DigitalOcean

You need a Twilio account with a voice-capable phone number, an Anthropic API key, an OpenAI API key with GPT-Live access, and a domain. GPT-Live costs about $0.05 per call minute on top of Twilio's per-minute rates and the Claude usage for delegated tasks.

1. **Create a droplet**: Ubuntu 24.04, Basic, 1 GB RAM ($6/mo) is enough. Turn on backups. Add your SSH key.
2. **DNS**: create an `A` record such as `agent.example.com` pointing at the droplet's IP.
3. **Install and configure** (on the droplet, as root):
   ```bash
   git clone https://github.com/metrospeed/tuahbots.git /opt/tuahbots
   cd /opt/tuahbots
   ./deploy/setup-droplet.sh            # installs Docker, opens ports 80/443
   cp .env.example .env && nano .env     # fill in the values
   docker compose up -d --build
   ```
   Caddy gets the HTTPS certificate on its own. Check `https://agent.example.com/healthz`.
4. **Point Twilio at it**: in Console → Phone Numbers → your number:
   - *A call comes in*: Webhook, `POST https://agent.example.com/twilio/voice`
   - *A message comes in* (optional, only logs texts): Webhook, `POST https://agent.example.com/twilio/sms`
5. **Invite people** at `https://agent.example.com/admin` → Invited users → *Create invite link*, then send them the link (email, Signal, whatever). They can add the page to their phone's home screen.

Updates: `./deploy/update.sh`. Nightly database backups: add `deploy/backup.sh` to cron.

## Local development

```bash
npm install
cp .env.example .env   # set DATABASE_URL and PUBLIC_BASE_URL (e.g. an ngrok https URL)
npm run dev
TEST_DATABASE_URL=postgres://... npm test
```

## Before you go live: compliance (not legal advice)

- **Texting**: the app sends no SMS, so A2P 10DLC registration doesn't apply. If you add texting later, you'll need it (Sole Proprietor registration works for individuals without an EIN).
- **AI voice calls (US)**: the FCC treats AI-generated voices as "artificial voice" under the TCPA. Calls to **cell phones** with an artificial voice generally need the called party's prior consent, unless they fall under an exemption such as emergencies. Calling businesses about an existing transaction (like a quote they sent) is lower risk than calling consumers, but it is not risk-free. Some states have their own AI-disclosure laws. Talk to a lawyer about how your users will use this.
- **Recording consent**: the greeting announces recording before anyone else speaks, which covers all-party-consent states such as California and Florida in most cases. Keep that greeting.
- You're responsible for what invited users ask the agent to do. Only invite people you trust, and review transcripts.
