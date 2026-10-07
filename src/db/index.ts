import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export interface User {
  id: number;
  name: string;
  phone: string | null;
  notes: string;
  active: boolean;
  login_token_hash: string | null;
  login_token_expires_at: Date | null;
  session_version: number;
  email: string | null;
  password_hash: string | null;
  chat_cleared_at: Date | null;
  created_at: Date;
}

export interface Task {
  id: number;
  user_id: number;
  kind: "call" | "sms";
  target_phone: string;
  target_name: string;
  objective: string;
  context: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  result: string;
  created_at: Date;
  completed_at: Date | null;
}

export type ConversationKind = "user_web" | "user_call" | "task_call" | "unknown_sms" | "unknown_call" | "user_sms" | "task_sms";

export interface Conversation {
  id: number;
  kind: ConversationKind;
  user_id: number | null;
  task_id: number | null;
  counterpart_phone: string;
  direction: "inbound" | "outbound";
  call_sid: string | null;
  call_status: string | null;
  recording_sid: string | null;
  recording_duration: number | null;
  summary: string;
  started_at: Date;
  ended_at: Date | null;
  last_activity_at: Date;
  cleared_at: Date | null;
}

export type MessageRole = "user" | "counterpart" | "assistant" | "event";

export interface Message {
  id: number;
  conversation_id: number;
  role: MessageRole;
  body: string;
  twilio_sid: string | null;
  created_at: Date;
}

export interface Attachment {
  id: number;
  message_id: number;
  content_type: string;
  data: Buffer;
  created_at: Date;
}

export async function findActiveUserByPhone(phone: string): Promise<User | undefined> {
  return queryOne<User>("SELECT * FROM users WHERE phone = $1 AND active", [phone]);
}

export async function getUser(id: number): Promise<User | undefined> {
  return queryOne<User>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function getTask(id: number): Promise<Task | undefined> {
  return queryOne<Task>("SELECT * FROM tasks WHERE id = $1", [id]);
}

export async function isBlocked(phone: string): Promise<boolean> {
  return !!(await queryOne("SELECT 1 FROM blocked_numbers WHERE phone = $1", [phone]));
}

export async function createConversation(c: {
  kind: ConversationKind;
  userId?: number | null;
  taskId?: number | null;
  counterpartPhone: string;
  direction: "inbound" | "outbound";
  callSid?: string | null;
}): Promise<Conversation> {
  const row = await queryOne<Conversation>(
    `INSERT INTO conversations (kind, user_id, task_id, counterpart_phone, direction, call_sid)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [c.kind, c.userId ?? null, c.taskId ?? null, c.counterpartPhone, c.direction, c.callSid ?? null],
  );
  return row!;
}

export async function addMessage(conversationId: number, role: MessageRole, body: string, twilioSid?: string): Promise<Message> {
  const row = await queryOne<Message>(
    "INSERT INTO messages (conversation_id, role, body, twilio_sid) VALUES ($1, $2, $3, $4) RETURNING *",
    [conversationId, role, body, twilioSid ?? null],
  );
  await pool.query("UPDATE conversations SET last_activity_at = now() WHERE id = $1", [conversationId]);
  return row!;
}

export async function listMessages(conversationId: number, limit = 500): Promise<Message[]> {
  return query<Message>(
    `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id`,
    [conversationId, limit],
  );
}

export interface UserNumber {
  id: number;
  user_id: number;
  phone: string;
  name: string;
  callback_allowed: boolean;
  callback_locked: boolean;
  hidden: boolean;
  last_called_at: Date;
  created_at: Date;
}
