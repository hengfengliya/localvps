// 起一个演示实例（独立 HOME、独立端口，不碰本机正在用的 localvps），按分镜一步步灌调用、切设置，
// 用本机 Chrome 按 3 倍清晰度截下每个界面状态，同时记下要点的元素位置 → public/shots/
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "..");
const OUT = path.join(ROOT, "public/shots");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "localvps-demo-"));
const WORK = "/Users/Shared/localvps-workspace";
const MCP = 38787;
const PANEL = 38788;
const W = 1440;
const H = 900;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const child = spawn(process.execPath, [path.join(REPO, "dist/cli.js")], {
  env: {
    ...process.env,
    HOME,
    LOCALVPS_ENV: path.join(HOME, "demo.env"),
    LOCALVPS_PORT: String(MCP),
    LOCALVPS_PANEL_PORT: String(PANEL),
    LOCALVPS_OPEN_PANEL: "false",
    LOCALVPS_KEEP_AWAKE: "false",
    LOCALVPS_NAME: "MacBook-Pro",
    LOCALVPS_WORKDIR: WORK,
    LOCALVPS_TUNNEL: "cf-quick",
    LOCALVPS_CLOUDFLARED_PATH: path.join(os.homedir(), ".localvps/bin/cloudflared"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => fetch(`http://127.0.0.1:${PANEL}/api/state`).then((r) => r.json());
const act = (action, value) =>
  fetch(`http://127.0.0.1:${PANEL}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-localvps": "1" },
    body: JSON.stringify({ action, value }),
  });
const token = () => fs.readFileSync(path.join(HOME, "demo.env"), "utf8").match(/ACCESS_TOKEN=(.*)/)[1];
const call = (name, args) =>
  fetch(`http://127.0.0.1:${MCP}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

const shots = {};
async function shoot(page, name, hash, targets = {}) {
  // 先回空白页再打开，强制整页重载，拿到最新数据（只改 hash 不会重新拉数据）
  await page.goto("about:blank");
  await page.goto(`http://127.0.0.1:${PANEL}/#${hash}`);
  await page.waitForFunction(() => window.S && document.querySelector("#host")?.textContent);
  await sleep(600);
  const rects = {};
  for (const [k, sel] of Object.entries(targets)) {
    rects[k] = await page.$$eval(sel, (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  shots[name] = rects;
  console.log("shot", name);
}

try {
  // 等隧道连上
  for (let i = 0; ; i++) {
    const s = await state().catch(() => null);
    if (s?.status === "online") break;
    if (i > 90) throw new Error("隧道 90 秒没连上");
    await sleep(1000);
  }
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 3, colorScheme: "light" });
  const page = await ctx.newPage();

  // 调用日志：空 → 三次调用，每次一张
  await shoot(page, "logs-0", "logs");
  const calls = [
    ["list_dir", { path: "." }],
    ["write_file", { path: "blog/2026-11-04.md", content: "# 2026-11-04\n\n- 用 localvps 让 AI 远程写了这篇笔记\n- 控制台里每一次调用都看得到\n" }],
    ["read_file", { path: "blog/2026-11-04.md" }],
  ];
  for (let i = 0; i < calls.length; i++) {
    const r = await call(...calls[i]);
    if (!r.ok) throw new Error(`调用 ${calls[i][0]} 失败：HTTP ${r.status}`);
    await shoot(page, `logs-${i + 1}`, "logs", { rows: "tbody tr" });
  }

  // 设置：权限三档
  for (const p of ["readonly", "workspace", "full"]) {
    await act("set_permission", p);
    await shoot(page, `settings-${p}`, "settings", { seg: "#perm button" });
  }
  await act("set_permission", "workspace");

  // 连接
  await shoot(page, "connect", "connect", { copy: '[data-copy="snippet"]', url: "#c-url", snippet: "#c-snippet", nav: ".mx-nav a" });

  // 远程查看：手机尺寸打开查看链接
  const { viewUrl } = await state();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await pp.goto(viewUrl);
  await pp.waitForFunction(() => window.S && document.querySelector("#host")?.textContent, null, { timeout: 30000 });
  await sleep(1500);
  await pp.screenshot({ path: path.join(OUT, "remote.png") });
  shots.remote = {};
  console.log("shot remote");

  // 概览最后截，让监控曲线攒够点
  for (;;) {
    const s = await state();
    if (s.samples.length >= 55) break;
    await sleep(3000);
  }
  await shoot(page, "overview", "overview", { secs: "#v-overview .mx-sec", head: ".mx-head", nav: ".mx-nav a" });

  fs.writeFileSync(path.join(OUT, "shots.json"), JSON.stringify({ w: W, h: H, shots }, null, 2));
  await browser.close();
} finally {
  child.kill();
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
}
