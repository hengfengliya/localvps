import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import si from "systeminformation";
import { type Config, expandHome, newViewKey, type Permission, saveEnv } from "./config.js";
import html from "./panel-html.js";
import { runtime } from "./runtime.js";

export { html };

let machine = { host: os.hostname(), os: "", arch: os.arch(), cpu: "", cores: os.cpus().length };

export async function initMachine(cfg: Config) {
  const [osInfo, cpu] = await Promise.all([si.osInfo(), si.cpu()]);
  machine = { ...machine, host: cfg.name, os: `${osInfo.distro} ${osInfo.release}`.trim(), cpu: `${cpu.manufacturer} ${cpu.brand}`.trim() };
}

/** 面板数据。remote＝通过查看链接远程看：不带令牌、密钥和设置项 */
export function buildState(cfg: Config, remote: boolean) {
  const today = new Date().toDateString();
  const todayLogs = runtime.logs.filter((l) => new Date(l.time).toDateString() === today);
  const base = {
    remote,
    machine,
    startedAt: runtime.startedAt,
    status: runtime.paused ? "paused" : runtime.tunnel,
    tunnelKind: cfg.tunnel,
    mcpUrl: runtime.publicUrl ? `${runtime.publicUrl}/mcp` : "",
    permission: cfg.permission,
    samples: runtime.samples,
    logs: runtime.logs.slice(-60).reverse(),
    stats: {
      calls: todayLogs.filter((l) => l.tool).length,
      errors: todayLogs.filter((l) => l.tool && l.error).length,
      blocked: todayLogs.filter((l) => l.event === "unauthorized").length,
    },
  };
  if (remote) return base;
  return {
    ...base,
    token: cfg.token,
    viewUrl: runtime.publicUrl && runtime.tunnel !== "local" ? `${runtime.publicUrl}/view?k=${cfg.viewKey}` : "",
    workdir: cfg.workdir,
    port: cfg.port,
    publicUrl: cfg.publicUrl,
    hasCfToken: !!cfg.cfTunnelToken,
    keepAwake: cfg.keepAwake,
    openPanel: cfg.openPanel,
  };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

// 面板上的每个操作；返回错误文案或 undefined
function apply(cfg: Config, action: string, v: any): string | undefined {
  switch (action) {
    case "pause":
    case "resume":
      runtime.paused = action === "pause";
      return;
    case "restart_tunnel":
      if (cfg.tunnel === "none") return "没有开隧道";
      runtime.tunnel = "connecting";
      runtime.restartTunnel();
      return;
    case "reset_token":
      cfg.token = "lvps_" + randomBytes(24).toString("base64url");
      saveEnv(cfg.envFile, "ACCESS_TOKEN", cfg.token);
      return;
    case "reset_view_key":
      cfg.viewKey = newViewKey();
      saveEnv(cfg.envFile, "VIEW_KEY", cfg.viewKey);
      return;
    case "set_permission":
      if (!["readonly", "workspace", "full"].includes(v)) return "权限只有只读、工作目录、完全权限三档";
      cfg.permission = v as Permission;
      saveEnv(cfg.envFile, "PERMISSION", v);
      return;
    case "set_workdir": {
      const dir = path.resolve(expandHome(String(v || "").trim()));
      if (!String(v || "").trim()) return "填一个文件夹路径";
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return `建不了这个文件夹：${dir}`;
      }
      cfg.workdir = dir;
      saveEnv(cfg.envFile, "WORKDIR", dir);
      return;
    }
    case "set_tunnel": {
      const kind = v?.kind;
      if (!["cf-quick", "cloudflare", "none"].includes(kind)) return "隧道只有临时地址、固定域名、不用隧道三种";
      if (kind === "cloudflare") {
        const token = String(v.token || "").trim() || cfg.cfTunnelToken;
        const url = String(v.url || "").trim().replace(/\/+$/, "");
        if (!token) return "填 Cloudflare 隧道令牌";
        if (!/^https:\/\/[^/\s]+$/.test(url)) return "域名写成 https://vps.example.com 这样";
        cfg.cfTunnelToken = token;
        cfg.publicUrl = url;
        saveEnv(cfg.envFile, "CF_TUNNEL_TOKEN", token);
        saveEnv(cfg.envFile, "PUBLIC_URL", url);
      }
      cfg.tunnel = kind;
      saveEnv(cfg.envFile, "TUNNEL", kind);
      runtime.applyTunnel();
      return;
    }
    case "set_keep_awake":
      cfg.keepAwake = !!v;
      saveEnv(cfg.envFile, "KEEP_AWAKE", String(cfg.keepAwake));
      runtime.setKeepAwake(cfg.keepAwake);
      return;
    case "set_open_panel":
      cfg.openPanel = !!v;
      saveEnv(cfg.envFile, "OPEN_PANEL", String(cfg.openPanel));
      return;
    default:
      return "unknown action";
  }
}

/** 本机控制面板：只监听 127.0.0.1，不经过隧道。 */
export async function startPanel(cfg: Config): Promise<string> {
  const allowedHosts = [`127.0.0.1:${cfg.panelPort}`, `localhost:${cfg.panelPort}`];

  const server = http.createServer(async (req, res) => {
    // 防 DNS 重绑定：只认本机 Host；写操作要求自定义头，跨站页面发不出这种请求
    if (!allowedHosts.includes(req.headers.host || "")) return json(res, 403, { error: "forbidden" });
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, buildState(cfg, false));

    if (req.method === "POST" && url.pathname === "/api/action") {
      if (req.headers["x-localvps"] !== "1") return json(res, 403, { error: "forbidden" });
      const { action, value } = await readBody(req).catch(() => ({}));
      const error = apply(cfg, action, value);
      return error ? json(res, 400, { error }) : json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.panelPort, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${cfg.panelPort}`;
}
