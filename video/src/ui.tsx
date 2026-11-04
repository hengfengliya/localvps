import React from "react";
import { Img, staticFile } from "remotion";
import { FONT, INK, INK3, INK4, LINE, PAGE, Rect, WIN, prog } from "./lib";

/** macOS 红绿灯 */
export const TrafficLights: React.FC<{ x?: number; y?: number }> = ({ x = 16, y = 14 }) => (
  <div style={{ position: "absolute", left: x, top: y, display: "flex", gap: 8 }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
      <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.18)" }} />
    ))}
  </div>
);

/** 一个窗口：标题栏（红绿灯＋标题或地址栏）＋内容 */
export const Window: React.FC<{ x: number; y: number; w: number; h: number; title?: string; url?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ x, y, w, h, title, url, children, style }) => (
  <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 14, overflow: "hidden", background: PAGE,
    boxShadow: "0 30px 80px rgba(11,11,11,0.16), 0 0 0 1px rgba(11,11,11,0.08)", ...style }}>
    <div style={{ position: "absolute", left: 0, top: 0, right: 0, height: 44, background: "#f4f4f1", borderBottom: `1px solid ${LINE}` }}>
      <TrafficLights x={18} y={16} />
      {url ? (
        <div style={{ position: "absolute", left: "50%", top: 8, transform: "translateX(-50%)", width: Math.min(560, w - 220), height: 28, borderRadius: 8, background: "#fff",
          boxShadow: `0 0 0 1px ${LINE}`, fontFamily: FONT, fontSize: 14, lineHeight: "28px", color: INK3, textAlign: "center" }}>{url}</div>
      ) : null}
      {title ? <div style={{ position: "absolute", left: 0, right: 0, top: 0, lineHeight: "44px", textAlign: "center", fontFamily: FONT, fontSize: 14, fontWeight: 500, color: INK3 }}>{title}</div> : null}
    </div>
    <div style={{ position: "absolute", left: 0, top: 44, right: 0, bottom: 0, overflow: "hidden" }}>{children}</div>
  </div>
);

/** 一张 1440×900 的截图按 scale 铺开 */
export const Shot: React.FC<{ name: string; scale: number; opacity?: number }> = ({ name, scale, opacity = 1 }) => (
  <Img src={staticFile(`shots/${name}.png`)} style={{ position: "absolute", left: 0, top: 0, width: WIN.w * scale, height: WIN.h * scale, opacity }} />
);

/** 从截图里裁一块 r（截图坐标）显现出来：先用页底色盖住，再浮上来 */
export const Reveal: React.FC<{ name: string; scale: number; r: Rect; b: number; at: number; dur?: number }> = ({ name, scale, r, b, at, dur = 0.8 }) => {
  const p = prog(b, at, at + dur);
  if (p >= 1) return null;
  const [x, y, w, h] = r.map((v) => v * scale);
  return (
    <>
      <div style={{ position: "absolute", left: x - 2, top: y - 2, width: w + 4, height: h + 4, background: PAGE }} />
      {p > 0 ? (
        <div style={{ position: "absolute", left: x, top: y, width: w, height: h, overflow: "hidden", opacity: p, transform: `translateY(${(1 - p) * 18}px)` }}>
          <Img src={staticFile(`shots/${name}.png`)} style={{ position: "absolute", left: -x, top: -y, width: WIN.w * scale, height: WIN.h * scale, maxWidth: "none" }} />
        </div>
      ) : null}
    </>
  );
};

/** 光标：x、y 为容器坐标；down 0–1 为按下程度，ring 0–1 为点击波纹 */
export const Cursor: React.FC<{ x: number; y: number; down: number; ring: number; opacity: number }> = ({ x, y, down, ring, opacity }) => (
  <div style={{ position: "absolute", left: x, top: y, opacity, pointerEvents: "none" }}>
    {ring > 0 && ring < 1 ? (
      <div style={{ position: "absolute", left: -18 * (0.4 + ring), top: -18 * (0.4 + ring), width: 36 * (0.4 + ring), height: 36 * (0.4 + ring), borderRadius: "50%", border: `2px solid rgba(11,11,11,${0.35 * (1 - ring)})` }} />
    ) : null}
    <svg width="22" height="30" viewBox="0 0 22 30" style={{ position: "absolute", left: -3, top: -2, transform: `scale(${1 - down * 0.14})`, transformOrigin: "3px 2px", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.3))" }}>
      <path d="M3 2 L3 24 L8.6 18.8 L12.4 27.4 L16 25.8 L12.3 17.4 L19.6 17.2 Z" fill="#0b0b0b" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  </div>
);

/** 屏幕下方的字幕：中文一行，下面一行小号英文 */
export const Caption: React.FC<{ zh: string; en: string; b: number; from: number; to: number }> = ({ zh, en, b, from, to }) => {
  if (b < from - 0.1 || b > to + 0.6) return null;
  const chip = prog(b, from, from + 0.5) * (1 - prog(b, to, to + 0.5));
  const chars = [...zh];
  const enIn = prog(b, from + 0.5, from + 1.1);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, display: "flex", justifyContent: "center", opacity: chip }}>
      <div style={{ padding: "16px 34px 14px", borderRadius: 20, background: "rgba(252,252,251,0.95)", boxShadow: "0 10px 40px rgba(0,0,0,0.10), 0 0 0 1px rgba(11,11,11,0.06)",
        fontFamily: FONT, color: INK, textAlign: "center", transform: `translateY(${(1 - chip) * 10}px) scale(${0.97 + 0.03 * chip})` }}>
        <div style={{ fontSize: 40, lineHeight: "52px", fontWeight: 600, letterSpacing: "0.01em" }}>
          {chars.map((c, i) => {
            const p = prog(b, from + 0.1 + i * 0.03, from + 0.55 + i * 0.03);
            return <span key={i} style={{ display: "inline-block", whiteSpace: "pre", opacity: p, transform: `translateY(${(1 - p) * 12}px)`, filter: `blur(${(1 - p) * 6}px)` }}>{c}</span>;
          })}
        </div>
        <div style={{ fontSize: 20, lineHeight: "28px", fontWeight: 400, color: INK4, opacity: enIn, marginTop: 2 }}>{en}</div>
      </div>
    </div>
  );
};
