import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Cursor, Reveal, Shot, Window } from "./ui";
import { FONT, FPB, INK, INK2, INK3, INK4, LINE, MONO, PAGE, Rect, TIMELINE, WIN, center, inOutScene, out, prog, shots } from "./lib";

const SC = TIMELINE.scenes as unknown as Record<string, [number, number]>;
const useBeat = () => useCurrentFrame() / FPB;

/** 字一个个浮上来的一行 */
const Line: React.FC<{ b: number; at: number; text: string; size: number; weight?: number; color?: string; top: number; step?: number }> = ({ b, at, text, size, weight = 600, color = INK, top, step = 0.035 }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top, textAlign: "center", fontSize: size, fontWeight: weight, color, letterSpacing: "0.01em" }}>
    {[...text].map((c, i) => {
      const p = prog(b, at + i * step, at + 0.5 + i * step, out);
      return <span key={i} style={{ display: "inline-block", whiteSpace: "pre", opacity: p, transform: `translateY(${(1 - p) * 20}px)`, filter: `blur(${(1 - p) * 8}px)` }}>{c}</span>;
    })}
  </div>
);

// ① 开场两句话
export const Hook: React.FC = () => {
  const b = useBeat();
  if (b > SC.hook[1] + 0.2) return null;
  const a = 1 - prog(b, 3.4, 3.9);
  const c = 1 - prog(b, 7.4, 8);
  return (
    <AbsoluteFill style={{ fontFamily: FONT }}>
      <div style={{ opacity: a }}>
        <Line b={b} at={0.3} text="你的电脑上，什么都有。" size={76} top={430} />
        <Line b={b} at={1.0} text="Your computer has everything." size={30} weight={400} color={INK4} top={540} step={0.012} />
      </div>
      <div style={{ opacity: b > 3.8 ? c : 0 }}>
        <Line b={b} at={4.0} text="可 AI 不在这台电脑上。" size={76} top={430} />
        <Line b={b} at={4.7} text="But your AI isn't running on it." size={30} weight={400} color={INK4} top={540} step={0.012} />
      </div>
    </AbsoluteFill>
  );
};

// ② 终端里一行安装
const CMD = "curl -fsSL https://raw.githubusercontent.com/hengfengliya/localvps/main/install.sh | sh";
const OUTPUT: [number, string, string?][] = [
  [12.2, "下载 localvps-macos-arm64 …"],
  [12.8, "已安装到 ~/.local/bin/localvps"],
  [13.6, "本地服务已启动：http://127.0.0.1:18787"],
  [14.2, "正在建立隧道…"],
  [15.6, "==================== localvps 已就绪 ====================", INK],
  [16.0, "控制台：  http://127.0.0.1:18788（只能在本机打开）", INK],
  [16.4, "MCP 地址：https://quiet-river-demo.trycloudflare.com/mcp", INK],
];
export const Install: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.install;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const typed = Math.floor(CMD.length * prog(b, 8.8, 11.4, (t) => t));
  const caret = Math.floor(b * 2) % 2 === 0 && b < 12;
  return (
    <AbsoluteFill style={{ opacity: vis, transform: `scale(${0.96 + 0.04 * vis})` }}>
      <Window x={260} y={220} w={1400} h={560} title="Terminal — zsh">
        <div style={{ position: "absolute", inset: 0, padding: "28px 36px", fontFamily: MONO, fontSize: 22, lineHeight: "36px", color: INK2, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          <div style={{ color: INK }}>
            <span style={{ color: INK4 }}>~ % </span>{CMD.slice(0, typed)}
            {caret ? <span style={{ display: "inline-block", width: 12, height: 26, background: INK, verticalAlign: "-5px", marginLeft: 2 }} /> : null}
          </div>
          {OUTPUT.map(([at, text, color], i) => {
            const p = prog(b, at, at + 0.3, out);
            return p > 0 ? <div key={i} style={{ opacity: p, color: color ?? INK2, fontWeight: color ? 600 : 400 }}>{text}</div> : null;
          })}
        </div>
      </Window>
    </AbsoluteFill>
  );
};

// ③ 控制台概览逐块浮现
const S1 = 0.9;
const WX = (1920 - WIN.w * S1) / 2;
export const Overview: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.overview;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const o = shots.overview;
  const zoom = 1 + 0.035 * prog(b, a, z, (t) => t);
  return (
    <AbsoluteFill style={{ opacity: vis, transform: `scale(${(0.97 + 0.03 * vis) * zoom})` }}>
      <Window x={WX} y={34} w={WIN.w * S1} h={WIN.h * S1 + 44} url="127.0.0.1:18788">
        <Shot name="overview" scale={S1} />
        <Reveal name="overview" scale={S1} r={o.head[0]} b={b} at={20.5} />
        {o.secs.map((r, i) => <Reveal key={i} name="overview" scale={S1} r={r} b={b} at={21 + i * 0.9} dur={1} />)}
      </Window>
    </AbsoluteFill>
  );
};

/** 点击动作：光标从 from 走到 to，at 拍按下 */
const click = (b: number, from: [number, number], to: [number, number], moveAt: number, at: number) => {
  const m = prog(b, moveAt, at - 0.15);
  return {
    x: from[0] + (to[0] - from[0]) * m,
    y: from[1] + (to[1] - from[1]) * m,
    down: prog(b, at - 0.1, at) * (1 - prog(b, at + 0.1, at + 0.3)),
    ring: prog(b, at, at + 0.7, (t) => t),
  };
};

// ④ 连接页：点「复制」
export const Connect: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.connect;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const s = shots.connect;
  const copy = s.copy[0].map((v) => v * S1) as Rect;
  const target = center(copy);
  const c = click(b, [WIN.w * S1 * 0.55, WIN.h * S1 * 0.75], target, 32.4, 34);
  const done = prog(b, 34.05, 34.25);
  const snip = s.snippet[0].map((v) => v * S1) as Rect;
  const glow = prog(b, 34, 34.3) * (1 - prog(b, 36, 37));
  return (
    <AbsoluteFill style={{ opacity: vis, transform: `scale(${0.97 + 0.03 * vis})` }}>
      <Window x={WX} y={34} w={WIN.w * S1} h={WIN.h * S1 + 44} url="127.0.0.1:18788/#connect">
        <Shot name="connect" scale={S1} />
        <div style={{ position: "absolute", left: snip[0] - 4, top: snip[1] - 4, width: snip[2] + 8, height: snip[3] + 8, borderRadius: 14, boxShadow: `0 0 0 2px rgba(11,11,11,${0.5 * glow})` }} />
        {done > 0 ? (
          <div style={{ position: "absolute", left: copy[0], top: copy[1], width: copy[2], height: copy[3], borderRadius: 7, background: "#fff", boxShadow: `inset 0 0 0 1px rgba(11,11,11,0.16)`,
            fontFamily: FONT, fontSize: 13 * S1 * 0.98, fontWeight: 500, lineHeight: `${copy[3]}px`, textAlign: "center", color: INK, opacity: done }}>已复制</div>
        ) : null}
        <Cursor x={c.x} y={c.y} down={c.down} ring={c.ring} opacity={prog(b, 31.6, 32.2)} />
      </Window>
    </AbsoluteFill>
  );
};

// ⑤ 左边 Claude Code 对话，右边调用日志一行行出现
const CHAT: [number, React.ReactNode][] = [
  [41.0, <><b>⏺ localvps · list_dir</b><span style={{ color: INK4 }}>  .</span></>],
  [41.4, <span style={{ color: INK4 }}>  ⎿  (空)</span>],
  [44.0, <><b>⏺ localvps · write_file</b><span style={{ color: INK4 }}>  blog/2026-11-04.md</span></>],
  [44.4, <span style={{ color: INK4 }}>  ⎿  wrote 112 bytes</span>],
  [47.0, <><b>⏺ localvps · read_file</b><span style={{ color: INK4 }}>  blog/2026-11-04.md</span></>],
  [47.4, <span style={{ color: INK4 }}>  ⎿  # 2026-11-04 …</span>],
  [50.0, <span style={{ fontFamily: FONT, color: INK }}>⏺ 写好了：blog/2026-11-04.md，记了今天用 localvps 让 AI 远程写笔记这件事。</span>],
];
const ASK = "帮我在 blog 里写今天的笔记";
const LOGS: [number, string][] = [[0, "logs-0"], [41.4, "logs-1"], [44.4, "logs-2"], [47.4, "logs-3"]];
const CROP_X = 300; // 截掉侧栏
const LW = 1148;
export const AI: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.ai;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const typed = Math.floor(ASK.length * prog(b, 38.8, 40.2, (t) => t));
  const cur = LOGS.filter(([at]) => b >= at).length - 1;
  return (
    <AbsoluteFill style={{ opacity: vis }}>
      <Window x={24} y={70} w={700} h={684} title="Claude Code" style={{ transform: `translateX(${(1 - vis) * -40}px)` }}>
        <div style={{ position: "absolute", inset: 0, padding: "26px 28px", fontFamily: MONO, fontSize: 18, lineHeight: "30px", color: INK2, whiteSpace: "pre-wrap" }}>
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "#f1f0ec", color: INK, fontFamily: FONT, fontSize: 20, marginBottom: 22 }}>
            <span style={{ color: INK4 }}>&gt; </span>{ASK.slice(0, typed)}
          </div>
          {CHAT.map(([at, node], i) => {
            const p = prog(b, at, at + 0.35, out);
            return p > 0 ? <div key={i} style={{ opacity: p, transform: `translateY(${(1 - p) * 8}px)`, marginTop: i % 2 === 0 && i > 0 ? 14 : 0 }}>{node}</div> : null;
          })}
        </div>
      </Window>
      <Window x={748} y={70} w={LW} h={684} url="127.0.0.1:18788/#logs" style={{ transform: `translateX(${(1 - vis) * 40}px)` }}>
        {LOGS.map(([at, name], i) => {
          const op = i === 0 ? 1 : prog(b, at, at + 0.3);
          return op > 0 && i <= cur + 1 ? (
            <Img key={name} src={staticFile(`shots/${name}.png`)} style={{ position: "absolute", left: -CROP_X, top: 0, width: WIN.w, height: WIN.h, opacity: op, maxWidth: "none" }} />
          ) : null;
        })}
        {cur > 0 ? (() => {
          const r = shots[LOGS[cur][1]].rows[0];
          const f = 1 - prog(b, LOGS[cur][0] + 0.2, LOGS[cur][0] + 1.6);
          return <div style={{ position: "absolute", left: r[0] - CROP_X, top: r[1], width: r[2], height: r[3], background: `rgba(42,120,214,${0.10 * f})` }} />;
        })() : null}
      </Window>
    </AbsoluteFill>
  );
};

// ⑥ 设置页：权限三档
const S2 = 1.15;
const PX = 296;
export const Perms: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.perms;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const seg = shots["settings-workspace"].seg.map((r) => [(r[0] - PX) * S2, r[1] * S2, r[2] * S2, r[3] * S2] as Rect);
  // 工作目录 → 只读 → 完全权限 → 工作目录
  const steps: [number, string, number][] = [[a, "workspace", 1], [58, "readonly", 0], [60, "full", 2], [62, "workspace", 1]];
  const cur = steps.filter(([at]) => b >= at).length - 1;
  const pos = (i: number) => center(seg[i]);
  let cx = pos(1)[0] - 120, cy = pos(1)[1] + 120, down = 0, ring = 0;
  for (let i = 1; i < steps.length; i++) {
    const c = click(b, i === 1 ? [cx, cy] : pos(steps[i - 1][2]), pos(steps[i][2]), steps[i][0] - 1.2, steps[i][0]);
    if (b >= steps[i][0] - 1.2) ({ x: cx, y: cy, down, ring } = c);
  }
  const W = (WIN.w - PX) * S2;
  const Hh = 620;
  return (
    <AbsoluteFill style={{ opacity: vis, transform: `scale(${0.97 + 0.03 * vis})` }}>
      <Window x={(1920 - W) / 2} y={70} w={W} h={Hh + 44} url="127.0.0.1:18788/#settings">
        {steps.map(([at, p], i) => {
          const op = i === 0 ? 1 : prog(b, at + 0.05, at + 0.3);
          return op > 0 && i <= cur ? (
            <Img key={i} src={staticFile(`shots/settings-${p}.png`)} style={{ position: "absolute", left: -PX * S2, top: 0, width: WIN.w * S2, height: WIN.h * S2, opacity: op, maxWidth: "none" }} />
          ) : null;
        })}
        <Cursor x={cx} y={cy} down={down} ring={ring} opacity={prog(b, 56.6, 57.2)} />
      </Window>
    </AbsoluteFill>
  );
};

// ⑦ 远程查看：这台电脑 → 另一台设备
export const Remote: React.FC = () => {
  const b = useBeat();
  const [a, z] = SC.remote;
  if (b < a - 0.2 || b > z + 0.2) return null;
  const vis = inOutScene(b, [a, z], 0.6, 0.5);
  const S3 = 0.5;
  const phoneIn = prog(b, 64.6, 65.6, out);
  const dash = prog(b, 64.4, 65.4);
  const PS = 0.9;
  const PW = 390 * PS, PH = 844 * PS;
  return (
    <AbsoluteFill style={{ opacity: vis, fontFamily: FONT }}>
      <Window x={170} y={250} w={WIN.w * S3} h={WIN.h * S3 + 44} url="127.0.0.1:18788">
        <Shot name="overview" scale={S3} />
      </Window>
      <div style={{ position: "absolute", left: 170, top: 760, width: WIN.w * S3, textAlign: "center", fontSize: 22, color: INK3 }}>这台电脑</div>
      <svg style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080 }}>
        <line x1={170 + WIN.w * S3 + 24} y1={500} x2={1250 - 24} y2={500} stroke={INK} strokeOpacity={0.35} strokeWidth={2.5} strokeDasharray="8 10" strokeDashoffset={-b * 18}
          style={{ clipPath: `inset(0 ${(1 - dash) * 100}% 0 0)` }} />
      </svg>
      <div style={{ position: "absolute", left: (170 + WIN.w * 0.5 + 1250) / 2, top: 455, transform: "translateX(-50%)", padding: "6px 14px", borderRadius: 999, background: PAGE,
        boxShadow: `0 0 0 1px ${LINE}`, fontSize: 18, color: INK2, opacity: dash }}>查看链接 · 只读</div>
      <div style={{ position: "absolute", left: 1250, top: 70 + (1 - phoneIn) * 40, width: PW + 24, height: PH + 24, borderRadius: 58, background: INK, opacity: phoneIn,
        boxShadow: "0 30px 80px rgba(11,11,11,0.22)" }}>
        <div style={{ position: "absolute", left: 12, top: 12, width: PW, height: PH, borderRadius: 46, overflow: "hidden", background: PAGE }}>
          <Img src={staticFile("shots/remote.png")} style={{ width: PW, height: PH }} />
        </div>
      </div>
      <div style={{ position: "absolute", left: 1250, top: 70 + PH + 40, width: PW + 24, textAlign: "center", fontSize: 22, color: INK3, opacity: phoneIn }}>另一台设备</div>
    </AbsoluteFill>
  );
};

// ⑧ 结尾：图标、名字、一句话、网址
export const End: React.FC = () => {
  const b = useBeat();
  const [a] = SC.end;
  if (b < a - 0.2) return null;
  const icon = prog(b, 72.4, 73.4, out);
  const fade = 1 - prog(b, 84.6, 86);
  const url = prog(b, 76.4, 77.2, out);
  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: INK, opacity: fade, transform: `scale(${1 + 0.03 * prog(b, a, 86, (t) => t)})` }}>
      <Img src={staticFile("shots/icon.png")} style={{ position: "absolute", left: 960 - 110, top: 180, width: 220, height: 220, opacity: icon, transform: `scale(${0.85 + 0.15 * icon}) translateY(${(1 - icon) * 20}px)` }} />
      <Line b={b} at={73.2} text="localvps" size={88} top={430} step={0.05} />
      <Line b={b} at={74.2} text="把你的电脑变成 AI 的服务器" size={42} weight={500} color={INK2} top={560} />
      <Line b={b} at={74.8} text="Turn your computer into a server for AI agents" size={26} weight={400} color={INK4} top={625} step={0.01} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 720, textAlign: "center", fontSize: 32, fontWeight: 500, letterSpacing: "0.02em", opacity: url, transform: `translateY(${(1 - url) * 14}px)` }}>
        github.com/hengfengliya/localvps
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 780, textAlign: "center", fontSize: 22, color: INK4, opacity: prog(b, 77, 77.8) }}>
        开源 · MIT · macOS / Windows
      </div>
    </AbsoluteFill>
  );
};

