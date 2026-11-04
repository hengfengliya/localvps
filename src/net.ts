import { spawnSync } from "node:child_process";

/**
 * 系统代理：环境变量 HTTPS_PROXY 优先，其次 macOS「网络」里的代理、Windows「Internet 选项」里的代理。
 * Clash 这类工具只开系统代理（不开 TUN）时，程序自己发的请求默认不走它，在国内下 GitHub 会很慢。
 */
export function systemProxy(): string | undefined {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env;
  try {
    if (process.platform === "darwin") {
      const o = spawnSync("scutil", ["--proxy"]).stdout?.toString() || "";
      const host = o.match(/HTTPSProxy : (\S+)/)?.[1];
      const port = o.match(/HTTPSPort : (\d+)/)?.[1];
      if (/HTTPSEnable : 1/.test(o) && host && port) return `http://${host}:${port}`;
    }
    if (process.platform === "win32") {
      const o =
        spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { windowsHide: true })
          .stdout?.toString("latin1") || "";
      const server = o.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
      if (/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(o) && server) {
        // 可能是 "127.0.0.1:7897"，也可能是 "http=...;https=..."
        const v = server.includes("=") ? server.match(/https=([^;]+)/)?.[1] || server.match(/http=([^;]+)/)?.[1] : server;
        if (v) return /^\w+:\/\//.test(v) ? v : `http://${v}`;
      }
    }
  } catch {
    // 读不到就直连
  }
  return undefined;
}

/** 先走系统代理，代理不通再直连。proxy 选项是 Bun 的；用 Node 跑源码时会被忽略，等于直连 */
export async function fetchSmart(url: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
  // 本机和局域网地址不走代理
  const host = new URL(url).hostname;
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(host);
  const proxy = local ? undefined : systemProxy();
  if (proxy) {
    try {
      return await fetch(url, { ...init, proxy, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
    } catch {
      // 代理不通，直连再试
    }
  }
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 下载整个文件，边下边报进度（0～1，不知道总大小时不报）。
 * 中途断线会从断开的位置续传（Range），最多再试 3 次；服务器不支持续传就从头下。
 */
export async function downloadFile(url: string, onProgress?: (p: number) => void, timeoutMs = 600_000): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let got = 0;
  let total = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetchSmart(url, got ? { headers: { range: `bytes=${got}-` } } : {}, timeoutMs);
      if (got && r.status !== 206) {
        chunks.length = 0; // 不支持续传，从头来
        got = 0;
      }
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      if (!total) total = got + (Number(r.headers.get("content-length")) || 0);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total && onProgress) onProgress(got / total);
      }
      if (total && got < total) throw new Error(`只下到 ${got}/${total} 字节`);
      return Buffer.concat(chunks);
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}
