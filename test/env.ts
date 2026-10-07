// Imported first by every test so config.ts sees a complete environment.
process.env.PUBLIC_BASE_URL ??= "https://agent.test";
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? "postgres://localhost/unused";
process.env.TWILIO_ACCOUNT_SID ??= "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN ??= "test-auth-token";
process.env.TWILIO_PHONE_NUMBER ??= "+15005550006";
process.env.ADMIN_PASSWORD ??= "admin-pass";
process.env.SESSION_SECRET ??= "session-secret";
process.env.ANTHROPIC_API_KEY ??= "sk-test";
