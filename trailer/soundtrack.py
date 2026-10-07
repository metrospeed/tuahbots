"""Synthesizes the trailer soundtrack (128 BPM electro + SFX) -> tuahbots-soundtrack.wav.

Everything is generated from scratch with numpy/scipy, so there is nothing to license.
Timings mirror the scene table in trailer.html (S.A ... S.H).
"""
import numpy as np
from pathlib import Path
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
DUR = 31.0
BEAT = 60 / 128
BAR = BEAT * 4
S = dict(A=0, A2=BAR, B=BAR * 2, C=BAR * 3, D=BAR * 4, E=BAR * 8, F=BAR * 12, G=BAR * 14, H=BAR * 15)
rng = np.random.default_rng(7)
N = int(SR * DUR)
music = np.zeros((N, 2))
sfx = np.zeros((N, 2))


def tt(d):
    return np.arange(int(d * SR)) / SR


def filt(x, kind, f, order=2):
    return sosfilt(butter(order, f, kind, fs=SR, output="sos"), x)


def add(buf, sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    if sig.ndim == 1:
        buf[i : i + len(sig), 0] += sig * gain * l * 1.414
        buf[i : i + len(sig), 1] += sig * gain * r * 1.414
    else:
        buf[i : i + len(sig)] += sig * gain


def env(n, a=0.002, d=0.2, total=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)
    return e


def saw(f, d, harmonics=None):
    t = tt(d)
    out = np.zeros_like(t)
    k = 1
    while k * f < min(9000, SR / 2) and (harmonics is None or k <= harmonics):
        out += np.sin(2 * np.pi * f * k * t) / k
        k += 1
    return out * 0.6


def note(n):  # midi -> Hz
    return 440 * 2 ** ((n - 69) / 12)


# ---------- drums ----------
def kick(big=False):
    d = 0.9 if big else 0.45
    t = tt(d)
    f = 45 + 160 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    k = np.sin(ph) * np.exp(-t * (4 if big else 8))
    k += 0.4 * filt(rng.standard_normal(len(t)), "highpass", 2000) * np.exp(-t * 120)
    return np.tanh(k * (2.2 if big else 1.6))


def clap():
    t = tt(0.3)
    n = filt(rng.standard_normal(len(t)), "bandpass", [900, 4500])
    e = np.exp(-t * 18)
    for off in (0.0, 0.011, 0.022):
        e += np.where(t >= off, np.exp(-(t - off) * 160), 0) * 0.6
    return n * e * 0.7


def hat(open_=False):
    t = tt(0.25 if open_ else 0.06)
    n = filt(rng.standard_normal(len(t)), "highpass", 7000)
    return n * np.exp(-t * (14 if open_ else 70)) * 0.35


def crash(d=2.5):
    t = tt(d)
    n = filt(rng.standard_normal(len(t)), "highpass", 4000)
    return n * np.exp(-t * 1.6) * 0.5


def snare():
    t = tt(0.25)
    n = filt(rng.standard_normal(len(t)), "bandpass", [1500, 8000]) * np.exp(-t * 22)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (n * 0.7 + body * 0.5)


def boom():  # sub impact for word slams
    t = tt(1.2)
    f = 30 + 90 * np.exp(-t * 6)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 3)
    n = filt(rng.standard_normal(len(t)), "lowpass", 900) * np.exp(-t * 10) * 0.5
    return np.tanh((s + n) * 1.8)


# ---------- synths ----------
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
BASS = [33, 29, 36, 31]


def supersaw(notes, d, cutoff=3500):
    t = tt(d)
    out = np.zeros((len(t), 2))
    for n in notes:
        for det, pan in ((-0.12, -0.7), (0.0, 0.0), (0.11, 0.7), (-0.05, -0.3), (0.06, 0.3)):
            s = saw(note(n + det), d, harmonics=24)
            out[:, 0] += s * (1 - pan) / 2
            out[:, 1] += s * (1 + pan) / 2
    out = np.stack([filt(out[:, c], "lowpass", cutoff) for c in range(2)], axis=1)
    return out * 0.09


def pluck(n, d=0.35, cutoff=2600):
    t = tt(d)
    s = saw(note(n), d, harmonics=16)
    return filt(s, "lowpass", cutoff) * np.exp(-t * 9) * 0.45


def bass_note(n, d):
    t = tt(d)
    s = saw(note(n), d, harmonics=12) + 0.6 * np.sin(2 * np.pi * note(n) * t)
    s = filt(s, "lowpass", 600) * np.minimum(1, t / 0.005) * np.exp(-t * 3)
    return np.tanh(s * 1.5) * 0.5


def telephone(x):
    return filt(x, "bandpass", [350, 3200], order=3)


# ---------- arrangement ----------
# A: four word slams
for i in range(4):
    add(music, boom(), S["A"] + i * BEAT, 0.55)
    add(music, kick(), S["A"] + i * BEAT, 0.6)
    add(music, crash(0.6), S["A"] + i * BEAT, 0.15, pan=(-1) ** i * 0.5)

# A2: cheesy hold music through a phone line
hold_mel = [69, 72, 76, 74, 72, 69, 71, 72]
for i, n in enumerate(hold_mel):
    t = tt(BEAT / 2 * 0.95)
    tone = np.sin(2 * np.pi * note(n + 12) * t) + 0.3 * np.sin(2 * np.pi * note(n + 24) * t)
    add(music, telephone(tone * np.exp(-t * 4)) * 0.35, S["A2"] + i * BEAT / 2)
for i in range(8):
    add(music, hat(), S["A2"] + i * BEAT / 2, 0.6)

# B: build — slams + snare roll + riser
for i in range(3):
    add(music, boom(), S["B"] + i * BEAT, 0.45)
    add(music, kick(), S["B"] + i * BEAT, 0.55)
roll_t = S["B"]
step = BEAT / 2
while roll_t < S["C"] - 0.02:
    k = (roll_t - S["B"]) / BAR
    add(music, snare(), roll_t, 0.12 + 0.35 * k)
    roll_t += step
    if roll_t > S["B"] + BEAT * 2:
        step = BEAT / 4
    if roll_t > S["B"] + BEAT * 3:
        step = BEAT / 8
rt = tt(BAR)
riser = filt(rng.standard_normal(len(rt)), "highpass", 800) * (rt / BAR) ** 2 * 0.35
f = 200 + 1800 * (rt / BAR) ** 2
riser += np.sin(2 * np.pi * np.cumsum(f) / SR) * (rt / BAR) ** 2 * 0.12
add(music, riser, S["B"])
add(music, supersaw(CHORDS[3], BAR, 1500) * np.linspace(0.2, 1, int(BAR * SR))[:, None], S["B"], 0.8)

# Drop: bars from C up to H
drop_start, drop_end = S["C"], S["H"]
nbars = round((drop_end - drop_start) / BAR)
for b in range(nbars):
    t0 = drop_start + b * BAR
    chord, root = CHORDS[b % 4], BASS[b % 4]
    rapid = t0 >= S["G"] - 1e-6
    for q in range(4):
        bt = t0 + q * BEAT
        add(music, kick(big=(b == 0 and q == 0)), bt, 0.85)
        if q in (1, 3):
            add(music, clap(), bt, 0.55)
        if rapid:
            add(music, snare(), bt, 0.5)
            add(music, crash(0.8), bt, 0.25, pan=(-1) ** q * 0.6)
        add(music, hat(open_=True), bt + BEAT / 2, 0.8, pan=0.3)
        for s16 in range(4):
            add(music, hat(), bt + s16 * BEAT / 4, 0.35 + 0.2 * (s16 % 2), pan=-0.3)
        add(music, bass_note(root, BEAT / 2 * 0.9), bt + BEAT / 2, 1.0)
    # pumping chord stabs on every off-beat, ducking on the kick
    stab = supersaw(chord, BAR, 4200 if not rapid else 6000)
    pump = np.ones(len(stab))
    for q in range(4):
        i0 = int(q * BEAT * SR)
        seg = np.arange(int(BEAT * SR)) / SR
        pump[i0 : i0 + len(seg)] = np.clip(0.15 + seg / (BEAT * 0.55), 0, 1)
    add(music, stab * pump[:, None], t0, 1.0)
    # lead hook
    hook = [0, 2, 3, 2, 0, 3, 4, 3]
    if S["D"] <= t0 < S["G"] and b % 2 == 0:
        for i, h in enumerate(hook):
            add(music, pluck(chord[h % 3] + 12 * (1 + h // 3)), t0 + i * BEAT / 2, 0.45, pan=0.2 * (-1) ** i)
    if b == 0 or t0 == S["E"] or t0 == S["F"]:
        add(music, crash(), t0, 0.5)

# H: final hit and ring-out
add(music, boom(), S["H"], 0.8)
add(music, kick(big=True), S["H"], 0.9)
add(music, crash(3.0), S["H"], 0.6)
end_d = DUR - S["H"]
final = supersaw([57, 60, 64, 69], end_d, 5000)
final *= np.exp(-tt(end_d) / 1.1)[:, None]
add(music, final, S["H"], 1.4)
add(music, bass_note(33, 1.5), S["H"], 1.0)
for i, n in enumerate([69, 72, 76, 81]):
    add(music, pluck(n + 12, 0.8, 5000), S["H"] + BEAT * 1.5 + i * BEAT / 2, 0.35)

# ---------- SFX ----------
def whoosh(d=0.45):
    t = tt(d)
    n = rng.standard_normal(len(t))
    out = np.zeros(len(t))
    for j, c in enumerate(np.linspace(400, 6000, 12)):
        seg = slice(j * len(t) // 12, (j + 1) * len(t) // 12)
        out[seg] = filt(n, "bandpass", [c * 0.7, c * 1.3])[seg]
    return out * (t / d) ** 2 * 0.6


for at in (S["D"], S["E"], S["F"], S["H"]):
    add(sfx, whoosh(), at - 0.45, 0.8)

# keyboard clicks while typing
type_start = S["D"] + 0.9
for i in range(34):
    ct = type_start + i * (2.0 / 34) + rng.uniform(-0.01, 0.01)
    t = tt(0.03)
    click = filt(rng.standard_normal(len(t)), "bandpass", [2000, 7000]) * np.exp(-t * 300)
    add(sfx, click, ct, 0.35, pan=rng.uniform(-0.3, 0.3))


def pop(f0=500, f1=1400, d=0.12):
    t = tt(d)
    f = f0 + (f1 - f0) * (t / d)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 30) * 0.5


add(sfx, pop(400, 900), S["D"] + 2.45, 0.7)  # attach
add(sfx, pop(600, 1800), S["D"] + 3.1, 0.8)  # send
add(sfx, pop(900, 1300), S["D"] + 4.2, 0.6)  # reply
add(sfx, pop(700, 1100), S["D"] + 4.4, 0.4)  # call added


def ding():
    out = np.zeros(int(0.9 * SR))
    for k, (f, off) in enumerate(((1318.5, 0), (1760, 0.11))):
        t = tt(0.7)
        s = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2.01 * t)) * np.exp(-t * 6)
        i = int(off * SR)
        out[i : i + len(s)] += s
    return out * 0.35


add(sfx, ding(), S["F"] + 0.25, 0.9)
add(sfx, ding(), S["F"] + 0.55, 0.5)

# phone ring at the start of the call (US ringback 440+480 Hz), through a phone line
t = tt(0.55)
ring = (np.sin(2 * np.pi * 440 * t) + np.sin(2 * np.pi * 480 * t)) * 0.25 * np.minimum(1, t / 0.01) * np.minimum(1, (0.55 - t) / 0.02)
add(sfx, telephone(ring), S["E"] - 0.05, 0.9)

# rapid-fire stamps
for q in range(4):
    add(sfx, boom()[: int(0.4 * SR)], S["G"] + q * BEAT + BEAT * 0.45, 0.45)

# ---------- mix ----------
ir_t = tt(1.6)
ir = rng.standard_normal((len(ir_t), 2)) * np.exp(-ir_t * 3.5)[:, None]
ir = np.stack([filt(ir[:, c], "lowpass", 6000) for c in range(2)], axis=1)
wet = np.stack([fftconvolve(music[:, c], ir[:, c])[:N] for c in range(2)], axis=1)
mix = music + wet * 0.025 + sfx
mix = np.stack([filt(mix[:, c], "highpass", 28) for c in range(2)], axis=1)
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.6) / np.tanh(1.6)  # glue / loudness
fade = np.ones(N)
fn = int(0.6 * SR)
fade[-fn:] = np.linspace(1, 0, fn)
mix *= fade[:, None] * 0.95
out = Path(__file__).with_name("tuahbots-soundtrack.wav")
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print("wrote", out)
