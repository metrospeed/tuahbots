/**
 * Locked out (lost phone and recovery codes)? Run on the server:
 *   docker compose exec app node dist/scripts/reset-admin-2fa.js
 * Two-factor is removed and every admin session ends; the next sign-in with
 * the admin password sets it up again.
 */
import { resetTwoFactor } from "../admin/auth.js";
import { pool } from "../db/index.js";

await resetTwoFactor();
await pool.end();
console.log("Admin two-factor reset. Sign in with the admin password to set it up again.");
