import { pool, query, queryOne, type Task, type User, type UserNumber } from "./db/index.js";

/**
 * Remember a number a user's agent called. Calling a number again puts it back
 * on their list, and lifts a lock from an earlier clear (call-back on again).
 * A call-back the user switched off themselves stays off.
 */
export async function recordCalledNumber(userId: number, phone: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_numbers (user_id, phone, name) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, phone) DO UPDATE SET
       name = COALESCE(NULLIF($3, ''), user_numbers.name),
       last_called_at = now(),
       hidden = FALSE,
       callback_allowed = user_numbers.callback_allowed OR user_numbers.callback_locked,
       callback_locked = FALSE`,
    [userId, phone, name],
  );
}

/** The numbers on a user's own list (not the ones they cleared). */
export async function listUserNumbers(userId: number): Promise<UserNumber[]> {
  return query<UserNumber>("SELECT * FROM user_numbers WHERE user_id = $1 AND NOT hidden ORDER BY last_called_at DESC", [userId]);
}

export type ToggleResult = "ok" | "not_found" | "locked";

/**
 * Turn call-back on or off for one number. Pass `userId` to limit it to that
 * user's visible numbers (the user's own panel); omit it for the admin.
 * Locked numbers can't be turned back on here.
 */
export async function setCallbackAllowed(numberId: number, allowed: boolean, userId?: number): Promise<ToggleResult> {
  const row = await queryOne<UserNumber>(
    `SELECT * FROM user_numbers WHERE id = $1 ${userId === undefined ? "" : "AND user_id = $2 AND NOT hidden"}`,
    userId === undefined ? [numberId] : [numberId, userId],
  );
  if (!row) return "not_found";
  if (row.callback_locked && allowed) return "locked";
  await pool.query("UPDATE user_numbers SET callback_allowed = $2 WHERE id = $1", [numberId, allowed]);
  return "ok";
}

/**
 * Clear a user's number list: the numbers disappear from their list and can't
 * call back until the user asks the agent to call them again. The admin still
 * sees them.
 */
export async function clearUserNumbers(userId: number): Promise<number> {
  const result = await pool.query(
    "UPDATE user_numbers SET hidden = TRUE, callback_locked = TRUE, callback_allowed = FALSE WHERE user_id = $1 AND NOT hidden",
    [userId],
  );
  return result.rowCount ?? 0;
}

/**
 * Clear a user's chat: start a fresh thread (the old one stays in the admin
 * panel), forget earlier tasks in the user's view and the agent's memory, and
 * clear their number list.
 */
export async function clearChat(user: User): Promise<void> {
  await pool.query("UPDATE conversations SET cleared_at = now() WHERE user_id = $1 AND kind = 'user_web' AND cleared_at IS NULL", [user.id]);
  await pool.query("UPDATE users SET chat_cleared_at = now() WHERE id = $1", [user.id]);
  await clearUserNumbers(user.id);
}

/**
 * The task a call from this number should be connected to: the latest one
 * from any active user who still allows this number to call back.
 */
export async function callbackTaskForNumber(phone: string): Promise<Task | undefined> {
  return queryOne<Task>(
    `SELECT t.* FROM tasks t
     JOIN user_numbers n ON n.user_id = t.user_id AND n.phone = t.target_phone
     JOIN users u ON u.id = t.user_id
     WHERE t.target_phone = $1 AND n.callback_allowed AND NOT n.callback_locked AND u.active AND t.status <> 'cancelled'
     ORDER BY t.id DESC LIMIT 1`,
    [phone],
  );
}
