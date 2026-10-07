-- Idempotent schema; applied at startup.

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT UNIQUE,                   -- E.164; optional, lets them call the agent
  notes       TEXT NOT NULL DEFAULT '',      -- shared with the agent as background about this user
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
-- Invite links: we keep only a hash of the token. Bumping session_version
-- signs the user out everywhere (new link, disabled user).
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_token_hash TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS blocked_numbers (
  phone       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A request from an invited user for the agent to call or text a third party.
CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('call', 'sms')),
  target_phone  TEXT NOT NULL,
  target_name   TEXT NOT NULL DEFAULT '',
  objective     TEXT NOT NULL,
  context       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  result        TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_target_idx ON tasks (target_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id, created_at DESC);

-- A single thread of communication: an invited user's web chat, a call with
-- an invited user, a call with a third party for a task, or an inbound text
-- or call from an unknown number. (user_sms/task_sms are from an earlier
-- version that texted; nothing creates them now.)
CREATE TABLE IF NOT EXISTS conversations (
  id                SERIAL PRIMARY KEY,
  kind              TEXT NOT NULL,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  task_id           INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  counterpart_phone TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  call_sid          TEXT UNIQUE,
  call_status       TEXT,
  recording_sid     TEXT,
  recording_duration INTEGER,
  summary           TEXT NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
  CHECK (kind IN ('user_web', 'user_call', 'task_call', 'unknown_sms', 'unknown_call', 'user_sms', 'task_sms'));
CREATE INDEX IF NOT EXISTS conversations_activity_idx ON conversations (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, kind, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversations_task_idx ON conversations (task_id);

-- Transcript lines. role: 'user' (invited user), 'counterpart' (third party),
-- 'assistant' (the agent), 'event' (tool calls, status changes).
CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'counterpart', 'assistant', 'event')),
  body            TEXT NOT NULL DEFAULT '',
  twilio_sid      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

-- Files (photos, PDFs) users upload in the chat, e.g. a quote to discuss.
CREATE TABLE IF NOT EXISTS attachments (
  id            SERIAL PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL,
  data          BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);

-- Admin-editable settings (calls on/off, greetings, hours, time limit).
-- Missing keys fall back to the defaults in src/settings.ts.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
