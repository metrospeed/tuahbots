import type { Request, Response } from "express";
import { pool, query, queryOne } from "./db/index.js";
import { withLock } from "./lock.js";
import { deleteTwilioRecording, fetchRecording } from "./twilio.js";

/**
 * Recordings are copied from Twilio into our database, then deleted from
 * Twilio. The copy is always saved before the delete, and a sweeper retries
 * anything that failed (download or delete).
 */
export function archiveRecording(recordingSid: string, conversationId: number | null): Promise<void> {
  return withLock(`recording:${recordingSid}`, async () => {
    const stored = await queryOne<{ twilio_deleted_at: Date | null }>(
      "SELECT twilio_deleted_at FROM recordings WHERE recording_sid = $1",
      [recordingSid],
    );
    if (!stored) {
      const res = await fetchRecording(recordingSid);
      if (!res.ok) throw new Error(`Recording ${recordingSid} download failed: ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length) throw new Error(`Recording ${recordingSid} was empty`);
      const contentType = (res.headers.get("content-type") ?? "audio/mpeg").split(";")[0];
      await pool.query(
        `INSERT INTO recordings (recording_sid, conversation_id, content_type, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (recording_sid) DO NOTHING`,
        [recordingSid, conversationId, contentType, data],
      );
    } else if (stored.twilio_deleted_at) {
      return;
    }
    if (await deleteTwilioRecording(recordingSid)) {
      await pool.query("UPDATE recordings SET twilio_deleted_at = now() WHERE recording_sid = $1", [recordingSid]);
    } else {
      throw new Error(`Recording ${recordingSid} saved, but deleting it from Twilio failed`);
    }
  });
}

/** Retry recordings that aren't copied yet, or are copied but still on Twilio. */
export async function sweepRecordings(): Promise<void> {
  const pending = await query<{ recording_sid: string; conversation_id: number | null }>(
    `SELECT c.recording_sid, c.id AS conversation_id FROM conversations c
     WHERE c.recording_sid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.recording_sid = c.recording_sid)
     UNION
     SELECT recording_sid, conversation_id FROM recordings WHERE twilio_deleted_at IS NULL
     LIMIT 50`,
  );
  for (const r of pending) {
    await archiveRecording(r.recording_sid, r.conversation_id).catch((err) => console.error("Recording archive retry failed", err.message));
  }
}

export function startRecordingSweeper(): void {
  const run = () => sweepRecordings().catch((err) => console.error("Recording sweep failed", err));
  setTimeout(run, 30_000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

/**
 * Send a conversation's recording: from our copy, or straight from Twilio if
 * it hasn't been copied yet. Supports byte ranges so players can seek.
 */
export async function sendRecording(req: Request, res: Response, recordingSid: string): Promise<void> {
  const stored = await queryOne<{ content_type: string; data: Buffer }>(
    "SELECT content_type, data FROM recordings WHERE recording_sid = $1",
    [recordingSid],
  );
  let data: Buffer;
  let contentType = "audio/mpeg";
  if (stored) {
    data = stored.data;
    contentType = stored.content_type;
  } else {
    const upstream = await fetchRecording(recordingSid);
    if (!upstream.ok) return void res.sendStatus(upstream.status === 404 ? 404 : 502);
    data = Buffer.from(await upstream.arrayBuffer());
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store");
  res.type(contentType);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = data.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return void res.sendStatus(416);
    }
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    return void res.send(data.subarray(start, end + 1));
  }
  res.send(data);
}
