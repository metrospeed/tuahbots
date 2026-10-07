# tuahbots

An invite-only AI phone agent. People you invite chat with it on a private web page and ask it to phone someone for them, for example:

> "Call (555) 123-4567, that's Mike at Acme Roofing. Get the status of the quote I just sent you and ask if they can start before the 20th."

The agent reads the photo or PDF of the quote the user uploaded, calls Mike with a brief built from it, opens the call by saying it's an AI assistant and that **the call is recorded**, has the conversation, then posts a summary in the user's chat. Every chat, call transcript, and recording shows up in an admin panel.

**The app never sends text messages**, so you don't need A2P 10DLC registration.

## How it works

```
Invited user ──web chat (/app)──────────────────────► app (Node/TS) ──► GPT-6 Luna (chat, tools)
  (optional) ──call──► Twilio number ──webhooks──────►  │  ▲
Third party ◄──call────────────────◄── Twilio REST ─────┘  │ delegated tasks
                                                         │  │
                    call audio (μ-law) ◄──Media Streams──►  app ◄──► OpenAI GPT-Live (voice)
                                                         │
                                       Postgres ◄────────┘──► /admin panel
```

- **Invite-only login**: there's no public sign-up. The admin invites someone and gets a one-time link (`/join/…`) to send them however they like. Links expire after 7 days and can be revoked anytime from Invited users. Opening it lets them create their login (email and password). After that they sign in at `/login` from any device and stay signed in for 180 days. They can change their password on the Account page, which signs out their other devices. If they forget it, the admin makes a **reset link**, which also signs them out everywhere until they use it. Passwords are stored with scrypt, and repeated failed sign-ins are throttled.
- **Web chat**: at `/app` they chat with the agent, attach photos or PDFs (like a quote), and see their calls with status, summary, transcript, and recording. While the page is open, the browser can show a notification when a call finishes.
- **Clear chat**: users can clear their chat. The agent forgets it and their earlier calls, and they start a fresh thread. Nothing is deleted: the old chat stays in the admin panel, marked "cleared by user". Clearing the chat also clears their number list (below).
- **Numbers and call-backs**: each user has a **Numbers** panel listing every number the agent called for them, with a **Call back** toggle. When a number calls the Twilio number, the agent only answers (with that request's context) if some user still allows it. Everyone else hears the "invited users only" message. **Clear list** removes the numbers from the user's view and locks their call-back off; the admin can't turn a locked number back on. It unlocks only when that user asks the agent to call the number again. The admin **Numbers** page shows every number from every user, including cleared ones, with the same toggles.
- **Calling in (optional)**: if you add a user's phone number, they can also call the Twilio number and talk to the agent. Texts to the number are logged in the admin panel and never answered.
- **Voice (GPT-Live)**: on every call, the caller's audio streams over [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) (`/twilio/stream`) to OpenAI's `gpt-live-1`. It's a full-duplex speech model: it listens while it talks and handles interruptions and "mhmm"s naturally. Twilio and GPT-Live both use 8 kHz μ-law audio, so nothing is converted. GPT-Live handles the conversation itself. When it needs something done (place a call, check a task, press keypad digits in a phone menu, hang up), it delegates the task. The agent model (GPT-6 Luna) then runs the same tools the chat agent uses, seeing the live transcript plus any files the user uploaded, and hands back a short result for GPT-Live to say. Transcripts are saved line by line as the call goes.
  - Prefer the old pipeline? Set `VOICE_ENGINE=relay` to use [Twilio ConversationRelay](https://www.twilio.com/docs/voice/conversationrelay) speech-to-text and text-to-speech with the agent model speaking directly.
- **Agent model**: the chat agent, the call agents, and call summaries run on OpenAI's `gpt-6-luna` through the Responses API (`AGENT_MODEL` to change it). Requests use `store: false`, so OpenAI doesn't keep conversations for later retrieval. Uploaded photos and PDFs go to the model directly.
- **Tasks**: the chat agent has tools: `call_number`, `list_tasks`, `followup_task` (calls again with new instructions), `cancel_task`. Each call is handled by an agent that only sees a written brief, not the user's whole history. It can press keypad digits for phone menus and leave voicemails. If the person calls back and the user allows call-backs from that number, the agent picks up with the same brief. When a call ends, the summary is posted in the requester's chat.
- **Disclosure**: every call starts with a greeting Twilio speaks word for word before the AI joins (a fixed `<Say>`, so the model can't skip or reword it), e.g. *"Hi Mike, this is Tuah, an AI assistant calling on behalf of Pat. This call is being recorded and transcribed."*
- **Recording**: outbound calls are recorded from the moment they're answered, and inbound calls as soon as the agent connects. When a recording is ready, the app copies it into your own database and then deletes it from Twilio, only after the copy is saved. A background job retries every 10 minutes if a download or delete fails, and on first start it also moves recordings already on Twilio. The admin and user pages play recordings from your server, with seeking. Recordings take roughly 0.5–1 MB per call minute in Postgres and are included in `deploy/backup.sh`.
- **Settings** (admin → Settings): a switch that **turns off all calls**. When off, the agent won't place or answer calls, any call in progress is hung up, and users see a notice in the chat. You can also edit the three **recording greetings** (with placeholders like `{agent}`, `{requester}`, `{recipient}`, `{caller}`), the **calling hours** and time zone, and the **call time limit**. Greetings must still say the call is recorded, and greetings to other people must say it's an AI assistant. The `.env` values are only the defaults.
- **Seamless handoff and hang-up**: Twilio plays the greeting word for word while the GPT-Live session is already starting, so the AI is ready the moment the greeting ends. Outbound calls fetch their instructions when the person picks up, so the greeting plays at pickup. When the conversation is done, GPT-Live says goodbye and hands off "hang up". The app then waits for Twilio to confirm the goodbye has finished playing and hangs up, so it isn't cut off and there's no dead air. Calls also end on their own after 45 seconds of silence or at the time limit, after a short goodbye.
- **Admin sign-in**: the admin password plus a code from an authenticator app. On the first sign-in you scan a QR code and get 8 one-time recovery codes. Sessions last 30 minutes, and logging out ends every admin session. From Settings you can make new recovery codes or move 2FA to a new phone. Locked out with no phone and no recovery codes? On the server run `docker compose exec app node dist/scripts/reset-admin-2fa.js`, then sign in with the password to set it up again. The 2FA secret is encrypted with `SESSION_SECRET`, so changing that secret means setting up 2FA again.
- **Security headers**: a strict Content Security Policy allows only the app's own script files, with no inline scripts or event handlers. Other sites can't embed the pages, browsers are told to use HTTPS only (HSTS), and nosniff and Permissions-Policy headers are set.
- **Admin panel** (`/admin`, password + 2FA): transcripts (searchable, with audio, attachments, and AI summaries), tasks, invited users (invite links, optional phone number, per-user notes for the agent), and blocked numbers.

### Guardrails built in
- Only invited, active users can use the agent. Invite links are stored hashed, sessions are signed cookies, and disabling a user signs them out everywhere. Everyone else gets nothing.
- You can block numbers in the admin panel. The agent will never call them.
- Calls to third parties are limited to set hours (default 8am–9pm), allowed countries (default US/CA), and a daily cap per user. Calls have a time limit. Emergency and short-code numbers can't be dialed.
- Twilio webhook signatures are checked. The voice websocket only accepts a single-use token minted for that call.
- The agent's instructions forbid harassment, marketing calls, impersonating the user, making commitments, or agreeing to payments.

## Deploy on DigitalOcean

You need a Twilio account with a voice-capable phone number, an OpenAI API key (with GPT-Live access), and a domain. Everything AI runs on OpenAI: `gpt-6-luna` for the chat agent, call handling and summaries (about $0.10 / $0.50 per million input/output tokens), and `gpt-live-1` for voice (about $0.05 per call minute), on top of Twilio's per-minute rates.

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
