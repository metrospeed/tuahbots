# tuahbots

An invite-only AI phone agent. People you invite text or call one phone number and ask the agent to call or text someone else for them, for example:

> "Call (555) 123-4567, that's Mike at Acme Roofing. Get the status of the quote I just sent you and ask if they can start before the 20th."

The agent reads the photo or PDF of the quote the user texted, calls Mike with a brief built from it, opens the call by saying it's an AI assistant and that **the call is recorded**, has the conversation, then texts the user a summary. Every text, call transcript, and recording shows up in an admin panel.

## How it works

```
Invited user ──SMS/call──► Twilio number ──webhooks──► app (Node/TS) ──► Claude
                                   ▲                     │
Third party ◄──call/SMS────────────┘◄── Twilio REST ─────┘
                                                         │
                                       Postgres ◄────────┘──► /admin panel
```

- **SMS**: Twilio posts to `/twilio/sms`. Texts from invited users go to the *user agent*. Replies from a number the agent contacted for a task go to that task's *task agent*. Texts from anyone else are logged and get no reply.
- **Voice**: calls use [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay), which handles speech-to-text and text-to-speech over a websocket (`/twilio/relay`). Claude's reply is streamed back token by token, so the agent starts speaking quickly. Callers can interrupt it.
- **Tasks**: the user agent has tools: `call_number`, `text_number`, `list_tasks`, `followup_task`, `cancel_task`. A task gets its own agent, which only sees a written brief, not the user's whole history. On calls it can press keypad digits for phone menus and leave voicemail. When the task finishes, the requester gets a text with the result.
- **Disclosure**: every call starts with a greeting the caller can't interrupt, e.g. *"Hi Mike, this is Tuah, an AI assistant calling on behalf of Pat. This call is being recorded and transcribed."* The first text to a new number ends with a footer saying it's an AI assistant writing for that person, with STOP instructions.
- **Recording**: outbound calls are recorded from the moment they're answered, and inbound calls as soon as the agent connects. You can play recordings in the admin panel, which streams them from Twilio.
- **Admin panel** (`/admin`, password login): transcripts (searchable, with audio, attachments, and AI summaries), tasks, invited users (with optional welcome text and per-user notes for the agent), and blocked numbers.

### Guardrails built in
- Only invited, active users can command the agent. Everyone else gets nothing.
- People who reply STOP are blocked automatically. You can block numbers by hand as well.
- Calls and texts to third parties are limited to set hours (default 8am–9pm), allowed countries (default US/CA), and a daily cap per user. Calls have a time limit. Emergency and short-code numbers can't be dialed.
- Twilio webhook signatures are checked. The voice websocket only accepts a single-use token minted for that call.
- The agent's instructions forbid harassment, marketing calls, impersonating the user, making commitments, or agreeing to payments.

## Deploy on DigitalOcean

You need a Twilio account with a phone number (voice + SMS), an Anthropic API key, and a domain.

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
   - *A message comes in*: Webhook, `POST https://agent.example.com/twilio/sms`
5. **Invite people** at `https://agent.example.com/admin` → Invited users.

Updates: `./deploy/update.sh`. Nightly database backups: add `deploy/backup.sh` to cron.

## Local development

```bash
npm install
cp .env.example .env   # set DATABASE_URL and PUBLIC_BASE_URL (e.g. an ngrok https URL)
npm run dev
TEST_DATABASE_URL=postgres://... npm test
```

## Before you go live: compliance (not legal advice)

- **Texting (US)**: Twilio requires **A2P 10DLC registration** for business texting from a local number, or a verified toll-free number. Unregistered traffic gets filtered. Texting people who never opted in is sensitive, so keep the first message clearly identified and transactional (the footer does this), and honor STOP (automatic).
- **AI voice calls (US)**: the FCC treats AI-generated voices as "artificial voice" under the TCPA. Calls to **cell phones** with an artificial voice generally need the called party's prior consent, unless they fall under an exemption such as emergencies. Calling businesses about an existing transaction (like a quote they sent) is lower risk than calling consumers, but it is not risk-free. Some states have their own AI-disclosure laws. Talk to a lawyer about how your users will use this.
- **Recording consent**: the greeting announces recording before anyone else speaks, which covers all-party-consent states such as California and Florida in most cases. Keep that greeting.
- You're responsible for what invited users ask the agent to do. Only invite people you trust, and review transcripts.
