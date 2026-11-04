import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Permission = "readonly" | "workspace" | "full";
export type TunnelKind = "cf-quick" | "cloudflare" | "none";

export interface Config {
  token: string;
  viewKey: string; // 远程查看链接的密钥，只能看不能操作
  name: string; // 控制台里显示的名字
  permission: Permission;
  workdir: string;
  tunnel: TunnelKind;
  cfTunnelToken: string;
  publicUrl: string;
  port: number;
  host: string;
  keepAwake: boolean;
  panelPort: number;
  openPanel: boolean;
  homeDir: string; // ~/.localvps：配置、cloudflared、审计日志
  envFile: string;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value || fallback) as T;
  if (!allowed.includes(v)) throw new Error(`${name}=${value} 无效，可选：${allowed.join(" | ")}`);
  return v;
}

// 不用 process.loadEnvFile：bun 编译的单文件版没有它
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * 配置固定放在 ~/.localvps/.env，与从哪个目录启动无关（双击运行时目录是用户主目录）。
 * 环境变量要加 LOCALVPS_ 前缀才覆盖文件里的值，免得被别的工具设的 PORT、HOST 带偏。
 */
export function loadConfig(): Config {
  const homeDir = path.join(os.homedir(), ".localvps");
  fs.mkdirSync(homeDir, { recursive: true });
  const envFile = process.env.LOCALVPS_ENV || path.join(homeDir, ".env");
  const file = readEnvFile(envFile);
  const get = (key: string): string | undefined => process.env[`LOCALVPS_${key}`] ?? file[key];

  let token = get("ACCESS_TOKEN") || "";
  if (!token) {
    token = "lvps_" + randomBytes(24).toString("base64url");
    saveEnv(envFile, "ACCESS_TOKEN", token);
    console.log(`已生成访问令牌，配置在 ${envFile}`);
  }
  let viewKey = get("VIEW_KEY") || "";
  if (!viewKey) {
    viewKey = newViewKey();
    saveEnv(envFile, "VIEW_KEY", viewKey);
  }

  const cfg: Config = {
    token,
    viewKey,
    name: get("NAME") || os.hostname(),
    permission: pick("PERMISSION", get("PERMISSION"), ["readonly", "workspace", "full"] as const, "workspace"),
    workdir: path.resolve(expandHome(get("WORKDIR") || "~/localvps-workspace")),
    tunnel: pick("TUNNEL", get("TUNNEL"), ["cf-quick", "cloudflare", "none"] as const, "cf-quick"),
    cfTunnelToken: get("CF_TUNNEL_TOKEN") || "",
    publicUrl: (get("PUBLIC_URL") || "").replace(/\/+$/, ""),
    port: Number(get("PORT") || 18787),
    host: get("HOST") || "127.0.0.1",
    keepAwake: (get("KEEP_AWAKE") || "true") !== "false",
    panelPort: Number(get("PANEL_PORT") || 18788),
    openPanel: (get("OPEN_PANEL") || "true") !== "false",
    envFile,
    homeDir,
  };
  if (cfg.tunnel === "cloudflare" && (!cfg.cfTunnelToken || !cfg.publicUrl)) {
    throw new Error(`TUNNEL=cloudflare 需要同时填 CF_TUNNEL_TOKEN 和 PUBLIC_URL（${envFile}）`);
  }
  fs.mkdirSync(cfg.workdir, { recursive: true });
  return cfg;
}

export const newViewKey = () => randomBytes(18).toString("base64url");

/** 把面板里改的设置写回 .env，下次启动沿用 */
export function saveEnv(file: string, key: string, value: string) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(text) ? text.replace(re, line) : text + (text && !text.endsWith("\n") ? "\n" : "") + line + "\n";
  fs.writeFileSync(file, next);
}
