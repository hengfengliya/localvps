import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { buildState, html, json } from "./panel.js";
import { audit as writeAudit, runtime } from "./runtime.js";
import { buildServer } from "./tools.js";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const authorized = (req: http.IncomingMessage, token: string) => same(req.headers.authorization || "", `Bearer ${token}`);

// 查看链接打开一次后换成 cookie，地址栏里不再带密钥；重置密钥后旧 cookie 自动失效
const viewCookie = (key: string) => createHash("sha256").update("localvps-view:" + key).digest("base64url");
const viewing = (req: http.IncomingMessage, key: string) =>
  same((req.headers.cookie || "").match(/(?:^|;\s*)lvps_view=([^;]+)/)?.[1] || "", viewCookie(key));

function denied(res: http.ServerResponse) {
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>localvps</title>' +
    '<p style="font:14px/1.6 -apple-system,PingFang SC,Microsoft YaHei,sans-serif;padding:48px 24px;color:#52514e">' +
    "查看链接无效或已重置。找这台电脑的主人要新的链接。</p>");
}

function handleView(req: http.IncomingMessage, res: http.ServerResponse, url: URL, cfg: Config) {
  const key = url.searchParams.get("k");
  if (url.pathname === "/view" && key) {
    if (!same(key, cfg.viewKey)) return denied(res);
    const https = req.headers["x-forwarded-proto"] === "https" || !!req.headers["cf-connecting-ip"];
    res.writeHead(302, {
      location: "/view",
      "set-cookie": `lvps_view=${viewCookie(cfg.viewKey)}; Path=/view; HttpOnly; SameSite=Lax; Max-Age=2592000${https ? "; Secure" : ""}`,
    });
    return void res.end();
  }
  if (!viewing(req, cfg.viewKey)) return url.pathname === "/view" ? denied(res) : json(res, 401, { error: "unauthorized" });
  if (url.pathname === "/view") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    return void res.end(html);
  }
  if (url.pathname === "/view/api/state") return json(res, 200, buildState(cfg, true));
  json(res, 404, { error: "not found" });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function send(res: http.ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export function startServer(cfg: Config): Promise<http.Server> {
  const audit = (entry: object) => writeAudit(cfg.homeDir, entry);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") return void res.end("ok");
    if (req.method === "GET" && (url.pathname === "/view" || url.pathname.startsWith("/view/"))) return handleView(req, res, url, cfg);
    if (url.pathname !== "/mcp") return send(res, 404, "Not found");
    if (!authorized(req, cfg.token)) {
      const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
      audit({ event: "unauthorized", ip: String(ip) });
      return send(res, 401, "Unauthorized");
    }
    if (runtime.paused) return send(res, 503, "Service paused on host");
    // 无状态模式：每个请求一套 server + transport，不需要会话
    if (req.method !== "POST") return send(res, 405, "Method not allowed");
    try {
      const body = await readJson(req);
      const server = buildServer(cfg, audit);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 400, e instanceof Error ? e.message : String(e));
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(cfg.port, cfg.host, () => resolve(httpServer));
  });
}
