import os from "node:os";
import { type Config, saveEnv } from "./config.js";
import { fetchSmart } from "./net.js";
import { machineInfo } from "./panel.js";
import { runtime } from "./runtime.js";
import { VERSION } from "./version.js";

const REPORT_EVERY = 5 * 60_000;

/** 邀请链接 https://host/i/CODE，或者已经绑过邀请服务时只填邀请码 */
export function parseInvite(input: string, cfg: Config): { hub: string; code: string } | undefined {
  const text = input.trim();
  const link = text.match(/^(https:\/\/[^/\s]+)\/i\/([A-Za-z0-9]{4,16})\/?$/);
  if (link) return { hub: link[1], code: link[2].toUpperCase() };
  if (/^[A-Za-z0-9]{4,16}$/.test(text) && cfg.hubUrl) return { hub: cfg.hubUrl, code: text.toUpperCase() };
}

async function post(url: string, body: object): Promise<any> {
  const r = await fetchSmart(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `localvps/${VERSION}` },
    body: JSON.stringify(body),
  }, 20_000);
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** 填邀请码：换来固定域名和隧道令牌，写进配置后按固定域名重开隧道 */
export async function redeemInvite(cfg: Config, input: string): Promise<string | undefined> {
  const inv = parseInvite(input, cfg);
  if (!inv) return "粘贴邀请链接，形如 https://localvps.beayy.com/i/ABCD2345";
  let r: { publicUrl: string; tunnelToken: string; secret: string };
  try {
    r = await post(`${inv.hub}/api/redeem`, { code: inv.code, name: cfg.name, port: cfg.port, os: machineInfo().os, version: VERSION });
  } catch (e) {
    return `邀请码没用上：${e instanceof Error ? e.message : e}`;
  }
  Object.assign(cfg, { tunnel: "cloudflare", cfTunnelToken: r.tunnelToken, publicUrl: r.publicUrl, hubUrl: inv.hub, hubCode: inv.code, hubSecret: r.secret });
  saveEnv(cfg.envFile, "TUNNEL", "cloudflare");
  saveEnv(cfg.envFile, "CF_TUNNEL_TOKEN", r.tunnelToken);
  saveEnv(cfg.envFile, "PUBLIC_URL", r.publicUrl);
  saveEnv(cfg.envFile, "HUB_URL", inv.hub);
  saveEnv(cfg.envFile, "HUB_CODE", inv.code);
  saveEnv(cfg.envFile, "HUB_SECRET", r.secret);
  runtime.hub.error = "";
  await runtime.applyTunnel();
  runtime.reportHub();
}

/** 自己改了隧道设置，就不再算邀请服务分配的地址，也不再上报 */
export function unbindHub(cfg: Config) {
  if (!cfg.hubCode) return;
  cfg.hubCode = cfg.hubSecret = "";
  saveEnv(cfg.envFile, "HUB_CODE", "");
  saveEnv(cfg.envFile, "HUB_SECRET", "");
  runtime.hub.error = "";
}

/** 定时上报；令牌、权限、地址变了由 runtime.reportHub() 立刻补一次 */
export function startHubReporter(cfg: Config) {
  let busy = false;
  const report = async () => {
    if (!cfg.hubCode || !cfg.hubSecret || busy) return;
    busy = true;
    try {
      await post(`${cfg.hubUrl}/api/report`, {
        code: cfg.hubCode,
        secret: cfg.hubSecret,
        name: cfg.name,
        os: machineInfo().os || `${os.platform()} ${os.release()}`,
        version: VERSION,
        permission: cfg.permission,
        accessToken: cfg.token,
        tunnel: runtime.paused ? "paused" : runtime.tunnel,
        viewUrl: runtime.publicUrl ? `${runtime.publicUrl}/view?k=${cfg.viewKey}` : "",
      });
      runtime.hub.error = "";
      runtime.hub.reportedAt = Date.now();
    } catch (e) {
      runtime.hub.error = `向邀请服务上报失败：${e instanceof Error ? e.message : e}`;
    } finally {
      busy = false;
    }
  };
  runtime.reportHub = () => void report();
  void report();
  setInterval(report, REPORT_EVERY).unref();
}
