# ШАБЛОН мелодии-интро для ролика. Адаптируй: BPM, T (длина), CH (прогрессия аккордов),
# CUTS (тайминги смен сцен = такты), LEAD (мелодия хука). Синтез numpy, без внешних сервисов.
# Ключ: тихое интро -> нарастание -> пик-хук -> финальный аккорд с ХВОСТОМ (см. bar 8). Выход: audio/beat.wav (стерео).
# Мелодичное интро для ролика «Как собрать продукт» — Am, 128 BPM, 8 тактов = 15.0с
# бас + арпеджио + лид + перкуссия, с интро-раскатом и разрешающим финалом (хвост)
import numpy as np, wave

sr = 44100
BPM = 128.0
beat = 60.0 / BPM            # 0.46875
bar  = 4 * beat              # 1.875
T = 8 * bar                  # 15.0
n = int(sr * T)
L = np.zeros(n); R = np.zeros(n)
rng = np.random.default_rng(11)

def midi(m): return 440.0 * 2 ** ((m - 69) / 12.0)

def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * sr); e = min(n, i + len(sig)); s = sig[:e - i]
    if e <= i: return
    lg = gain * np.sqrt((1 - pan) / 2); rg = gain * np.sqrt((1 + pan) / 2)
    L[i:e] += s * lg; R[i:e] += s * rg

# ---------- tonal synth ----------
def note(m, dur, kind="pluck", vib=0.0):
    N = int(sr * dur); t = np.arange(N) / sr; f = midi(m)
    if kind == "pluck":
        harm = [(1, 1.0), (2, 0.5), (3, 0.26), (4, 0.12)]; k = 5.5
        env = np.exp(-t * k)
        atk = int(sr * 0.004); env[:atk] *= np.linspace(0, 1, atk)
    elif kind == "bass":
        harm = [(1, 1.0), (2, 0.45), (3, 0.12)]; k = 3.2
        env = np.exp(-t * k); atk = int(sr * 0.006); env[:atk] *= np.linspace(0, 1, atk)
    elif kind == "pad":
        harm = [(1, 1.0), (2, 0.5), (3, 0.3), (4, 0.16), (5, 0.08)]
        env = np.ones(N); a = int(sr * 0.12); r = int(sr * 0.35)
        env[:a] = np.sin(np.linspace(0, np.pi / 2, a)); env[-r:] = np.cos(np.linspace(0, np.pi / 2, r)); env *= 0.9
    else:  # lead — hollow/odd harmonics + vibrato
        harm = [(1, 1.0), (3, 0.33), (5, 0.2), (7, 0.09)]; k = 1.4
        env = np.exp(-t * k * 0.5); a = int(sr * 0.02); env[:a] *= np.linspace(0, 1, a)
    fmod = 1 + vib * np.sin(2 * np.pi * 5.2 * t) if vib else 1.0
    sig = sum(a * np.sin(2 * np.pi * f * h * t * (fmod if h == 1 else 1)) for h, a in harm)
    return sig * env / 3.2

# ---------- percussion ----------
def kick(dur=0.18):
    t = np.arange(int(sr * dur)) / sr; fsw = 130 * np.exp(-t * 24) + 48
    return np.sin(2 * np.pi * np.cumsum(fsw) / sr) * np.exp(-t * 20) * 0.95
def hat(dur=0.03):
    t = np.arange(int(sr * dur)) / sr; nz = rng.standard_normal(len(t))
    return np.diff(nz, prepend=0) * np.exp(-t * 150) * 0.14
def clap(dur=0.22):
    t = np.arange(int(sr * dur)) / sr; nz = rng.standard_normal(len(t))
    body = nz * np.exp(-t * 16);
    tap = np.zeros_like(body)
    for d in (0, 0.008, 0.016):
        i = int(d * sr); tap[i:] += (nz * np.exp(-(t) * 22))[:len(t) - i]
    return (body * .5 + tap * .5) * 0.3
def riser(dur=0.4):
    t = np.arange(int(sr * dur)) / sr; e = (t / dur) ** 2
    f = 200 + 1400 * (t / dur)
    tone = np.sin(2 * np.pi * np.cumsum(f) / sr)
    nz = rng.standard_normal(len(t)) * 0.5
    return (tone * .6 + nz * .4) * e * 0.5
def impact(dur=0.6):
    t = np.arange(int(sr * dur)) / sr; body = np.sin(2 * np.pi * 46 * t) * np.exp(-t * 6.5)
    tr = rng.standard_normal(len(t)) * np.exp(-t * 45) * 0.5; return (body * .9 + tr) * 0.8
def crash(dur=1.9):
    t = np.arange(int(sr * dur)) / sr; nz = rng.standard_normal(len(t))
    hp = np.diff(nz, prepend=0); return hp * np.exp(-t * 2.6) * 0.28

# ---------- arrangement ----------
# chords per bar (triad midi + bass root)
CH = [
    ([57,60,64], 45),  # 1 Am
    ([53,57,60], 41),  # 2 F
    ([60,64,67], 48),  # 3 C
    ([55,59,62], 43),  # 4 G
    ([57,60,64], 45),  # 5 Am
    ([53,57,60], 41),  # 6 F
    ([55,59,62], 43),  # 7 G
    ([57,60,64], 45),  # 8 Am (resolve)
]
CUTS = [0, 3.75, 5.625, 7.50, 9.375, 11.25, 13.125]  # scene starts (= bar lines)

# sub drone under everything (soft), fades near end
tt = np.arange(n) / sr
drone_f = midi(33)  # A1
L += 0.05 * np.sin(2 * np.pi * drone_f * tt) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.2 * tt))
R[:] = L[:] * 0.0 + R[:]  # keep R independent below

for b in range(8):
    t0 = b * bar; tri, broot = CH[b]
    last = (b == 7)
    # bass — root on beat 1 (+ beat 3 for groove bars)
    add(note(broot, 1.2, "bass"), t0, 0.9)
    if 1 <= b <= 6: add(note(broot, 0.7, "bass"), t0 + 2 * beat, 0.6)
    # pad — sustained chord (each bar); bar8 rings long
    pdur = 3.2 if last else bar * 0.98
    for j, m in enumerate(tri):
        add(note(m, pdur, "pad"), t0, 0.16, pan=[-0.3, 0.0, 0.3][j])
    # arp — 8th notes, bars 2..7 full; bar1 sparse intro; bar8 none (let ring)
    if b == 0:
        seq = [tri[0], tri[2]]; step = 2 * beat  # sparse intro
    elif last:
        seq = []
    else:
        o = tri[0] + 12
        seq = [tri[0], tri[1], tri[2], o, tri[2], tri[1], tri[0], tri[1]]; step = beat / 2
    for k, m in enumerate(seq):
        add(note(m, 0.34, "pluck"), t0 + k * step, 0.34, pan=(-0.35 if k % 2 else 0.35))
    # kick 1&3 (bar2..7), bar1 & bar8 just downbeat
    if 1 <= b <= 6:
        add(kick(), t0, 1.0); add(kick(), t0 + 2 * beat, 0.9)
    else:
        add(kick(), t0, 1.0 if last else 0.8)
    # hats offbeat bars 3..7
    if 2 <= b <= 6:
        for hb in range(8):
            if hb % 2: add(hat(), t0 + hb * (beat / 2), 0.8, pan=0.2)
    # clap 2&4 bars 4..7
    if 3 <= b <= 6:
        add(clap(), t0 + beat, 0.7, pan=-0.1); add(clap(), t0 + 3 * beat, 0.7, pan=-0.1)

# lead melody (bars 5..8) — the hook, resolves on A
LEAD = [
    (5, [(76,1),(74,1),(72,1),(76,1)]),         # Am: E5 D5 C5 E5
    (6, [(72,2),(69,1),(65,1)]),                # F : C5 A4 F4
    (7, [(74,1),(71,1),(67,1),(71,1)]),         # G : D5 B4 G4 B4
    (8, [(69,4)]),                              # Am: A4 (resolve, whole)
]
for barno, seq in LEAD:
    t0 = (barno - 1) * bar; pos = 0.0
    for m, beats in seq:
        dur = beats * beat * (1.9 if (barno == 8) else 1.05)
        add(note(m, dur, "lead", vib=0.006), t0 + pos, 0.5)
        pos += beats * beat
# final sparkle high A5 on resolve
add(note(81, 2.0, "lead", vib=0.008), 8 * bar - bar, 0.28)

# scene-cut accents: riser lead-in + impact on the cut
for c in CUTS:
    if c > 0: add(riser(0.4), max(0, c - 0.4), 1.0, pan=0.0)
    add(impact(0.6), c, 0.9)
add(crash(1.9), 7 * bar, 0.9, pan=0.0)  # crash on final bar downbeat (13.125)

# ---------- light stereo space (multi-tap) on a copy ----------
def space(ch):
    out = ch.copy()
    for d, g in ((0.055, 0.22), (0.09, 0.15), (0.15, 0.10), (0.21, 0.06)):
        i = int(d * sr); out[i:] += ch[:n - i] * g
    return out
L = L + space(L) * 0.5
R = R + space(R) * 0.5

# ---------- master ----------
mx = max(np.abs(L).max(), np.abs(R).max()) + 1e-9
L = np.tanh(L / mx * 1.3) ; R = np.tanh(R / mx * 1.3)
peak = max(np.abs(L).max(), np.abs(R).max())
L *= 0.94 / peak; R *= 0.94 / peak
fi = int(sr * 0.03); fo = int(sr * 0.28)
for ch in (L, R):
    ch[:fi] *= np.linspace(0, 1, fi); ch[-fo:] *= np.linspace(1, 0, fo)

stereo = np.empty(n * 2, dtype=np.int16)
stereo[0::2] = (L * 32767).astype(np.int16)
stereo[1::2] = (R * 32767).astype(np.int16)
with wave.open("audio/beat.wav", "w") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(stereo.tobytes())
print("beat.wav:", round(n / sr, 2), "с, стерео, пик", round(peak, 3))
