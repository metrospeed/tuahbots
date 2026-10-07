// Renders trailer.html frame by frame and encodes it with ffmpeg.
//   node render.mjs                 -> out/tuahbots-trailer.mp4 (needs tuahbots-soundtrack.wav)
//   node render.mjs --stills 1,8,16 -> out/still-<t>.png for quick checks
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(join(process.execPath, "../../lib/node_modules/playwright")); }

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const FPS = 30;

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "trailer.html")).href + "?render");
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
const duration = await page.evaluate(() => window.DURATION);

const stillsArg = process.argv.indexOf("--stills");
if (stillsArg > 0) {
  for (const t of process.argv[stillsArg + 1].split(",").map(Number)) {
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({ path: join(out, `still-${t}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const audio = join(here, "tuahbots-soundtrack.wav");
const args = ["-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-"];
if (existsSync(audio)) args.push("-i", audio, "-c:a", "aac", "-b:a", "192k", "-shortest");
args.push("-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(out, "tuahbots-trailer.mp4"));
const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });

const frames = Math.round(duration * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => window.render(t), f / FPS);
  const buf = await page.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 60 === 0) process.stderr.write(`frame ${f}/${frames}\n`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await browser.close();
