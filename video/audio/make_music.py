#!/usr/bin/env python3
"""合成产品介绍视频的配乐和音效（原创，全部由本脚本用 numpy 算出来，没有采样、没有第三方素材）。
沿用 Beayy 产品介绍片的合成器；段落、旋律区间、滚奏、升调都从 src/timeline.json 读，不写死拍数。
用法：python3 audio/make_music.py → public/audio/music.wav、public/audio/sfx/<名字>.wav
节拍和段落读 src/timeline.json。F 大调，和弦四小节一循环：Fmaj9 | Am7 | Dm9 | B♭maj9。"""
import json
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TL = json.loads((ROOT / "src/timeline.json").read_text(encoding="utf-8"))
SR = 48000
BEAT = 60 / TL["bpm"]
TOTAL = TL["totalBeats"] * BEAT
N = int(TOTAL * SR) + SR
rng = np.random.default_rng(7)
SEC = {k: v for k, v in TL["music"].items()}


def t_of(beat):
    return int(round(beat * BEAT * SR))


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def in_sec(beat, *names):
    return any(SEC[n][0] <= beat < SEC[n][1] for n in names)


def lowpass_fft(x, cutoff, order=2):
    """频域低通（固定截止）"""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (f / cutoff) ** (2 * order))
    return np.fft.irfft(X, len(x))


def bandpass_fft(x, lo, hi, order=2):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR) + 1e-9
    X *= 1 / np.sqrt(1 + (f / hi) ** (2 * order)) * 1 / np.sqrt(1 + (lo / f) ** (2 * order))
    return np.fft.irfft(X, len(x))


def env_ad(n, a, d):
    """起音 a 秒、按 d 秒指数衰减"""
    t = np.arange(n) / SR
    e = np.exp(-t / d)
    na = max(1, int(a * SR))
    e[:na] *= np.linspace(0, 1, na)
    return e


def add(buf, start, sig, pan=0.0, gain=1.0):
    """放进立体声总线；pan -1 左 1 右"""
    if start >= buf.shape[1]:
        return
    sig = sig[: buf.shape[1] - start] * gain
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[0, start:start + len(sig)] += sig * l * 1.414
    buf[1, start:start + len(sig)] += sig * r * 1.414


# ---------- 乐器 ----------

def kick():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 46 + 90 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(ph) * env_ad(n, 0.001, 0.16)
    click = bandpass_fft(rng.standard_normal(n), 1500, 6000) * env_ad(n, 0.0005, 0.004)
    return np.tanh(1.6 * s) * 0.9 + click * 0.25


def clap():
    n = int(0.35 * SR)
    noise = bandpass_fft(rng.standard_normal(n), 900, 4200)
    e = np.zeros(n)
    for off in (0, 0.009, 0.018):
        k = int(off * SR)
        e[k:] += env_ad(n - k, 0.0005, 0.012)
    e += env_ad(n, 0.002, 0.09) * 0.6
    return noise * e * 0.5


def hat(open_=False):
    n = int((0.25 if open_ else 0.07) * SR)
    s = bandpass_fft(rng.standard_normal(n), 7000, 15000, 3)
    return s * env_ad(n, 0.0005, 0.09 if open_ else 0.018) * 0.35


def shaker():
    n = int(0.06 * SR)
    s = bandpass_fft(rng.standard_normal(n), 5000, 11000)
    return s * env_ad(n, 0.004, 0.015) * 0.16


def tick_wood():
    """钟表滴答：短促的木块声"""
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    s = (np.sin(2 * np.pi * 2350 * t) + 0.5 * np.sin(2 * np.pi * 3900 * t)) * env_ad(n, 0.0003, 0.008)
    s += bandpass_fft(rng.standard_normal(n), 3000, 9000) * env_ad(n, 0.0002, 0.003) * 0.4
    return s * 0.35


def ep(m, dur, vel=1.0, bright=1.0):
    """FM 电钢琴／拨弦"""
    n = int((dur + 1.2) * SR)
    t = np.arange(n) / SR
    fc = hz(m)
    idx = (1.6 * bright) * np.exp(-t / 0.25) + 0.15
    s = np.sin(2 * np.pi * fc * t + idx * np.sin(2 * np.pi * fc * t))
    s += 0.18 * np.sin(2 * np.pi * 4 * fc * t) * np.exp(-t / 0.05)  # 起音的叮
    e = env_ad(n, 0.003, 0.55)
    rel = np.clip((dur + 0.15 - t) / 0.15, 0, 1) ** 0.5 * 0.85 + 0.15
    return s * e * rel * vel * 0.22


def bell(m, dur, vel=1.0):
    n = int((dur + 2.5) * SR)
    t = np.arange(n) / SR
    fc = hz(m)
    s = np.sin(2 * np.pi * fc * t + 2.2 * np.exp(-t / 0.6) * np.sin(2 * np.pi * fc * 3.5 * t))
    return s * env_ad(n, 0.002, 1.1) * vel * 0.16


def pad(notes, dur, cutoff_k=6.0, vel=1.0):
    """几个微微走音的锯齿波叠起来，按谐波加权当作低通"""
    n = int((dur + 1.5) * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for m in notes:
        f0 = hz(m)
        for det in (-0.07, 0.0, 0.08):
            f = f0 * 2 ** (det / 12)
            ph = rng.uniform(0, 2 * np.pi)
            kmax = int(min(24, 9000 / f))
            for k in range(1, kmax + 1):
                w = (1 / k) * np.exp(-k / cutoff_k)
                out += w * np.sin(2 * np.pi * f * k * t + ph * k)
    a = np.clip(t / 0.9, 0, 1)
    r = np.clip((dur + 1.2 - t) / 1.2, 0, 1)
    return out * a * r / (len(notes) * 3) * vel * 0.55


def bass(m, dur):
    n = int((dur + 0.08) * SR)
    t = np.arange(n) / SR
    f = hz(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    e = np.clip(t / 0.006, 0, 1) * np.clip((dur + 0.06 - t) / 0.06, 0, 1) * (0.75 + 0.25 * np.exp(-t / 0.12))
    return np.tanh(1.3 * s) * e * 0.42


# 和弦：(低音, pad 音, 琶音音)
CHORDS = [
    (41, [57, 60, 64, 67], [65, 69, 72, 76, 79, 76, 72, 69]),   # Fmaj9
    (45, [55, 60, 64, 69], [69, 72, 76, 79, 81, 79, 76, 72]),   # Am7
    (38, [53, 57, 60, 64], [62, 65, 69, 72, 76, 72, 69, 65]),   # Dm9
    (46, [57, 62, 65, 72], [70, 74, 77, 81, 84, 81, 77, 74]),   # B♭maj9
]
MELODY = [  # (拍, 音, 拍长)，八小节一句，放在 summary 和 groove2 段
    (0, 76, 1.5), (1.5, 74, 0.5), (2, 72, 2), (4, 76, 1), (5, 77, 1), (6, 79, 2),
    (8, 81, 1.5), (9.5, 79, 0.5), (10, 76, 2), (12, 74, 1), (13, 72, 1), (14, 74, 2),
    (16, 76, 1.5), (17.5, 74, 0.5), (18, 72, 2), (20, 69, 1), (21, 72, 1), (22, 76, 2),
    (24, 77, 1.5), (25.5, 76, 0.5), (26, 74, 1), (27, 72, 1), (28, 72, 4),
]


def render_music():
    bus = np.zeros((2, N))
    send = np.zeros((2, N))  # 混响送出
    duck = np.ones(N)  # 跟着底鼓压低 pad 和贝斯
    K, C, HC, HO, SH, TK = kick(), clap(), hat(), hat(True), shaker(), tick_wood()
    end_beat = SEC["outro"][0]
    last = TL["totalBeats"]

    # 和弦层：每小节一个和弦
    for bar in range(int(last // 4)):
        b0 = bar * 4
        bass_n, pad_n, arp = CHORDS[bar % 4]
        if b0 >= end_beat + 4:
            break
        final = b0 >= end_beat
        dur = (4 if not final else 14) * BEAT
        open_k = 2.5 if in_sec(b0, "intro") else 4.0 if in_sec(b0, "build", "breakdown") else 6.0
        if final:
            pad_n, open_k = [53, 57, 60, 64, 67, 72], 5.0
            bass_n = 41
        p = pad(pad_n, dur, open_k, vel=0.75 if in_sec(b0, "intro") else 1.0)
        add(send, t_of(b0), p, 0, 0.6)
        add(bus, t_of(b0), p, 0, 0.9)
        if final:
            for i, m in enumerate([65, 72, 76, 79, 84]):
                add(bus, t_of(b0 + i * 0.5), bell(m, 6), (i - 2) * 0.3, 0.8)
                add(send, t_of(b0 + i * 0.5), bell(m, 6), 0, 0.9)
            add(bus, t_of(b0), bass(29, 6 * BEAT) * np.exp(-np.arange(int((6 * BEAT + 0.08) * SR)) / SR / 2.5), 0, 0.9)
            continue
        # 贝斯：build 之后才有，八分音符推进
        if not in_sec(b0, "intro"):
            pattern = [(0, 1.5), (1.5, 0.5), (2, 1), (3, 0.5), (3.5, 0.5)] if not in_sec(b0, "build", "breakdown") else [(0, 3.5)]
            for off, ln in pattern:
                m = bass_n + (12 if off == 3.5 else 0)
                add(bus, t_of(b0 + off), bass(m, ln * BEAT * 0.92), 0, 0.7 if not in_sec(b0, "breakdown") else 0.6)
        # 琶音：十六分音符一半密度（八分），groove 段全开
        if not in_sec(b0, "intro"):
            step = 0.5
            for i in range(8):
                beat = b0 + i * step
                m = arp[i]
                vel = 0.55 if in_sec(b0, "build") else 0.8 if in_sec(b0, "breakdown") else 0.7
                sig = ep(m, step * BEAT * 0.9, vel, bright=0.7 if in_sec(b0, "build") else 1.0)
                pan = -0.35 if i % 2 else 0.35
                add(bus, t_of(beat), sig, pan, 1.0)
                add(send, t_of(beat), sig, 0, 0.5)
        else:
            # 前奏：每小节一个低调的和弦拨
            for i, m in enumerate(pad_n):
                add(bus, t_of(b0 + i * 0.12), ep(m, 3.2 * BEAT, 0.45, 0.5), (i - 1.5) * 0.25)
                add(send, t_of(b0 + i * 0.12), ep(m, 3.2 * BEAT, 0.45, 0.5), 0, 0.7)

    # 旋律
    for s0, s1 in TL["melody"]:
        for rep in range(4):
            for b, m, ln in MELODY:
                beat = s0 + rep * 32 + b
                if beat >= s1:
                    break
                sig = bell(m, ln * BEAT * 0.9, 0.8)
                add(bus, t_of(beat), sig, 0.15, 0.75)
                add(send, t_of(beat), sig, 0, 0.9)

    # 鼓
    for i in range(int(end_beat * 4)):
        beat = i / 4
        if in_sec(beat, "intro"):
            continue
        full = in_sec(beat, "groove", "groove2")
        if beat % 1 == 0:
            if (full and True) or (in_sec(beat, "build") and beat % 2 == 0):
                add(bus, t_of(beat), K, 0, 0.95)
                st = t_of(beat)
                d = 1 - 0.55 * np.exp(-np.arange(int(0.3 * SR)) / SR / 0.09)
                duck[st:st + len(d)] = np.minimum(duck[st:st + len(d)], d[: max(0, min(len(d), N - st))])
            if full and beat % 2 == 1:
                add(bus, t_of(beat), C, 0.05, 0.75)
                add(send, t_of(beat), C, 0, 0.35)
        if beat % 1 == 0.5 and not in_sec(beat, "riser"):
            add(bus, t_of(beat), HO if (full and beat % 4 == 3.5) else HC, 0.3, 0.8 if full else 0.5)
        if full and beat % 0.5 == 0.25:
            add(bus, t_of(beat), SH, -0.4, 1.0)
        if in_sec(beat, "breakdown") and beat % 1 == 0.5:
            add(bus, t_of(beat), HC, -0.2, 0.4)
    # 前奏的钟表滴答：每拍一下
    for b in range(int(SEC["intro"][0]), int(SEC["intro"][1])):
        add(bus, t_of(b), TK, -0.2 if b % 2 else 0.2, 0.9)
        add(send, t_of(b), TK, 0, 0.3)
    # 段落前的军鼓滚奏
    for s0, s1 in TL["rolls"]:
        k = 0
        b = s0
        while b < s1:
            g = 0.15 + 0.5 * (b - s0) / (s1 - s0)
            add(bus, t_of(b), C * 0.9, 0, g)
            b += 0.25 if b < s1 - 1 else 0.125
            k += 1
    # 升调噪声
    for s0, s1 in TL["risers"]:
        n = t_of(s1) - t_of(s0)
        x = rng.standard_normal(n)
        ramp = np.linspace(0, 1, n) ** 2
        lo = lowpass_fft(x, 2500) * (1 - ramp) + bandpass_fft(x, 2000, 12000) * ramp
        add(bus, t_of(s0), lo * ramp * 0.18, 0)
        add(send, t_of(s0), lo * ramp * 0.18, 0, 0.6)

    # 压缩感：pad、贝斯这类长音跟着底鼓起伏（这里粗略地对整条总线做轻度侧链）
    bus *= 0.7 + 0.3 * duck
    # 混响：衰减噪声做冲激响应，左右各一条
    ir_n = int(2.4 * SR)
    t = np.arange(ir_n) / SR
    wet = np.zeros_like(send)
    for ch in range(2):
        ir = lowpass_fft(rng.standard_normal(ir_n), 6000) * np.exp(-t / 0.55)
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        L = 1 << int(np.ceil(np.log2(N + ir_n)))
        wet[ch] = np.fft.irfft(np.fft.rfft(send[ch], L) * np.fft.rfft(ir, L), L)[:N]
    mix = bus + wet * 0.55
    # 结尾淡出
    fade_from = t_of(TL["totalBeats"] - 5)
    f = np.ones(N)
    f[fade_from:] = np.linspace(1, 0, N - fade_from) ** 1.5
    mix *= f
    mix /= np.percentile(np.abs(mix), 99.9) / 0.6
    mix = np.tanh(mix)  # 偶尔的尖峰软削掉
    mix *= 0.85 / np.max(np.abs(mix))
    return mix[:, : t_of(TL["totalBeats"])]


# ---------- 音效 ----------

def sfx():
    out = {}
    def mono(n):
        return np.zeros(int(n * SR))
    # 点击：触控板那种短促的「嗒」
    n = int(0.06 * SR); t = np.arange(n) / SR
    out["click"] = (bandpass_fft(rng.standard_normal(n), 1800, 7000) * env_ad(n, 0.0002, 0.004) * 0.9
                    + np.sin(2 * np.pi * 1200 * t) * env_ad(n, 0.0002, 0.006) * 0.35)
    # 冒出：元素出现时轻轻一下
    n = int(0.18 * SR); t = np.arange(n) / SR
    f = 520 + 380 * (1 - np.exp(-t / 0.02))
    out["pop"] = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ad(n, 0.002, 0.04) * 0.35
    # 呼啸：镜头大幅移动
    for name, dur, lo, hi, g in [("whoosh", 0.9, 300, 5000, 0.5), ("swish", 0.35, 1200, 9000, 0.35), ("sweep", 1.6, 200, 2500, 0.3)]:
        n = int(dur * SR); t = np.arange(n) / SR
        x = rng.standard_normal(n)
        # 分段改截止频率，近似扫频
        y = np.zeros(n); seg = 2048
        for i in range(0, n, seg):
            p = i / n
            fc = lo * (hi / lo) ** (np.sin(np.pi * p) ** 1.5)
            y[i:i + seg] = lowpass_fft(x[i:i + seg], fc)
        e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
        out[name] = y * e * g
    # 蜡笔划过：带颗粒的擦纸声
    n = int(0.75 * SR); t = np.arange(n) / SR
    grain = 0.6 + 0.4 * np.abs(np.sin(2 * np.pi * 38 * t + 3 * np.sin(2 * np.pi * 7 * t)))
    out["crayon"] = bandpass_fft(rng.standard_normal(n), 1800, 6500) * grain * np.sin(np.pi * t / 0.75) ** 0.7 * 0.32
    # 打字：一串小点击
    n = int(1.6 * SR); y = np.zeros(n)
    k = 0
    while k < n - 3000:
        m = int(0.02 * SR)
        y[k:k + m] += bandpass_fft(rng.standard_normal(m), 2500, 9000) * env_ad(m, 0.0002, 0.003) * rng.uniform(0.4, 0.8)
        k += int(rng.uniform(0.055, 0.11) * SR)
    out["type"] = y * 0.6
    # 加锁：两下咔哒
    n = int(0.25 * SR); y = np.zeros(n)
    for off, g in [(0, 0.8), (0.07, 1.0)]:
        m = int(0.04 * SR); k = int(off * SR); tt = np.arange(m) / SR
        y[k:k + m] += (bandpass_fft(rng.standard_normal(m), 1000, 5000) * env_ad(m, 0.0002, 0.005) + np.sin(2 * np.pi * 900 * tt) * env_ad(m, 0.0002, 0.01) * 0.5) * g
    out["lock"] = y * 0.6
    # 提示音：两个音的上行
    n = int(1.4 * SR); t = np.arange(n) / SR; y = np.zeros(n)
    for off, m in [(0, 84), (0.09, 91)]:
        k = int(off * SR); tt = t[: n - k]
        y[k:] += np.sin(2 * np.pi * hz(m) * tt + 0.8 * np.exp(-tt / 0.3) * np.sin(2 * np.pi * hz(m) * 2 * tt)) * env_ad(n - k, 0.002, 0.35)
    out["chime"] = y * 0.18
    # 收尾的低音
    n = int(2.5 * SR); t = np.arange(n) / SR
    f = 38 + 30 * np.exp(-t / 0.1)
    out["boom"] = np.tanh(1.4 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * env_ad(n, 0.003, 0.7) * 0.6
    # 钟表滴答（音乐里已经有，单独一份备用）
    out["tick"] = tick_wood()
    # 起势：短促的上扬噪声
    n = int(BEAT * 2 * SR); x = rng.standard_normal(n); ramp = np.linspace(0, 1, n) ** 2
    out["riser"] = bandpass_fft(x, 1500, 10000) * ramp * 0.12
    return out


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if data.ndim == 1:
        data = np.vstack([data, data])
    pcm = (np.clip(data.T, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    out = ROOT / "public/audio"
    write(out / "music.wav", render_music())
    for k, v in sfx().items():
        v = v / max(1e-9, np.max(np.abs(v))) * min(0.9, np.max(np.abs(v)) * 1.8)
        write(out / "sfx" / f"{k}.wav", v)
    print("配乐和音效写好 →", out)
