// localvps 邀请服务：发邀请码，对方 localvps 填了就分到一个固定域名（Cloudflare 远端托管隧道），
// 之后定时上报地址、权限和令牌，邀请方在 /admin 里看所有机器在不在线、一键复制接入命令。
// 部署见 server/README.md。所需密钥（wrangler secret put）：CF_API_TOKEN、ADMIN_KEY。
import tokensCss from "../src/vendor/beayy/tokens.css";
import bundleCss from "../src/vendor/beayy/bundle.css";
import adminHtml from "./admin.html";

const CF = "https://api.cloudflare.com/client/v4";
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉容易看错的 0 O 1 I
const LABEL = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
// 这些子域名留给别的用途，不分给设备
const RESERVED = new Set(["www", "admin", "api", "mail", "localvps", "sync", "app", "status"]);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function cf(env, method, path, body) {
  const r = await fetch(CF + path, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(`Cloudflare ${method} ${path.split("/").slice(0, 4).join("/")}: ${j.errors?.map((e) => e.message).join("; ") || r.status}`);
  return j.result;
}

function randomCode(n = 8) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}
function randomSecret() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const getSeat = async (env, code) => env.KV.get(`seat:${code}`, "json");
const putSeat = (env, seat) => env.KV.put(`seat:${seat.code}`, JSON.stringify(seat));

// ---------- 设备端 ----------

/** 填邀请码：把隧道入口指到这台电脑的端口，发隧道令牌和上报用的密钥。重复填会换新密钥，旧电脑随之失效。 */
async function redeem(env, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const seat = code && (await getSeat(env, code));
  if (!seat) return json({ error: "邀请码不对，或者已经被收回" }, 404);
  const port = Number(body.port) || 18787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return json({ error: "端口不对" }, 400);
  await cf(env, "PUT", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${seat.tunnelId}/configurations`, {
    config: { ingress: [{ hostname: seat.hostname, service: `http://127.0.0.1:${port}` }, { service: "http_status:404" }] },
  });
  const secret = randomSecret();
  seat.secretHash = await sha256(secret);
  seat.redeemedAt = Date.now();
  seat.report = { name: String(body.name || "").slice(0, 80), os: String(body.os || "").slice(0, 80), version: String(body.version || "").slice(0, 20), at: Date.now() };
  await putSeat(env, seat);
  return json({ label: seat.label, publicUrl: `https://${seat.hostname}`, tunnelToken: seat.tunnelToken, secret });
}

/** 定时上报：地址、权限、令牌、版本。密钥对不上说明这个邀请码已经被别的电脑绑走了。 */
async function report(env, body) {
  const code = String(body.code || "").trim().toUpperCase();
  const seat = code && (await getSeat(env, code));
  if (!seat || !seat.secretHash || !sameText(await sha256(String(body.secret || "")), seat.secretHash)) {
    return json({ error: "这台电脑的绑定已失效（邀请码被收回，或在别的电脑上重新填过）" }, 401);
  }
  const s = (k, n) => String(body[k] ?? "").slice(0, n);
  seat.report = {
    name: s("name", 80), os: s("os", 80), version: s("version", 20), permission: s("permission", 20),
    accessToken: s("accessToken", 200), tunnel: s("tunnel", 20), viewUrl: s("viewUrl", 300), at: Date.now(),
  };
  await putSeat(env, seat);
  return json({ ok: true });
}

// ---------- 管理端 ----------

async function createSeat(env, body) {
  const label = String(body.label || "").trim().toLowerCase();
  if (!LABEL.test(label) || RESERVED.has(label)) return json({ error: "名字只用小写英文、数字、中划线，比如 sumo" }, 400);
  const hostname = `${label}.${env.DOMAIN}`;
  const exists = await cf(env, "GET", `/zones/${env.ZONE_ID}/dns_records?name=${hostname}`);
  if (exists.length) return json({ error: `${hostname} 已经有解析记录，换个名字` }, 409);

  const tunnel = await cf(env, "POST", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel`, { name: `localvps-${label}`, config_src: "cloudflare" });
  try {
    const tunnelToken = await cf(env, "GET", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/token`);
    await cf(env, "PUT", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`, {
      config: { ingress: [{ hostname, service: "http://127.0.0.1:18787" }, { service: "http_status:404" }] },
    });
    const dns = await cf(env, "POST", `/zones/${env.ZONE_ID}/dns_records`, {
      type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: "localvps 邀请服务自动创建",
    });
    let code;
    do code = randomCode(); while (await getSeat(env, code));
    const seat = { code, label, hostname, note: String(body.note || "").slice(0, 200), tunnelId: tunnel.id, tunnelToken, dnsId: dns.id, createdAt: Date.now() };
    await putSeat(env, seat);
    return json({ code });
  } catch (e) {
    await cf(env, "DELETE", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`).catch(() => {});
    throw e;
  }
}

async function deleteSeat(env, code) {
  const seat = await getSeat(env, code);
  if (!seat) return json({ error: "没有这个邀请码" }, 404);
  await cf(env, "DELETE", `/zones/${env.ZONE_ID}/dns_records/${seat.dnsId}`).catch(() => {});
  await cf(env, "DELETE", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${seat.tunnelId}/connections`).catch(() => {});
  await cf(env, "DELETE", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${seat.tunnelId}`).catch(() => {});
  await env.KV.delete(`seat:${code}`);
  return json({ ok: true });
}

async function listSeats(env, origin) {
  const keys = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "seat:", cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const seats = await Promise.all(keys.map((k) => env.KV.get(k.name, "json")));
  const out = await Promise.all(
    seats.filter(Boolean).map(async (s) => {
      // 在不在线以隧道连接为准：上报只代表最近一次报过
      const t = await cf(env, "GET", `/accounts/${env.ACCOUNT_ID}/cfd_tunnel/${s.tunnelId}`).catch(() => null);
      return {
        code: s.code, label: s.label, note: s.note, createdAt: s.createdAt, redeemedAt: s.redeemedAt || 0,
        publicUrl: `https://${s.hostname}`, invite: `${origin}/i/${s.code}`,
        online: t?.status === "healthy" || t?.status === "degraded", tunnelStatus: t?.status || "unknown",
        report: s.report || null,
      };
    }),
  );
  return json({ seats: out.sort((a, b) => b.createdAt - a.createdAt) });
}

// ---------- 页面 ----------

const style = `<style>${tokensCss}\n${bundleCss}</style>`;
const page = (title, body) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${style}` +
  `<style>body{padding:56px 24px}.wrap{max-width:560px;margin:0 auto}.wrap p{color:var(--ink-2)}code{font-family:var(--font-mono)}</style></head><body><div class="wrap">${body}</div></body></html>`;

function invitePage(code) {
  return page(
    "localvps 邀请",
    `<h1 class="mx-title">localvps 邀请</h1>
<p>这是一个 localvps 邀请链接。填好之后，这台电脑会得到一个固定地址，邀请你的人可以远程帮你操作这台电脑。</p>
<ol><li>打开 localvps（菜单栏图标 → 打开控制台，或在终端运行 <code>localvps</code>）</li>
<li>进入「设置 → 网络 → 隧道 → 更改」，选「邀请码」</li>
<li>把这个页面的链接粘贴进去，点保存</li></ol>
<p>还没装 localvps：<a href="https://github.com/hengfengliya/localvps/releases/latest">下载</a></p>
<p class="mx-setting-desc">邀请码：<code>${code}</code></p>`,
  );
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "POST" && p === "/api/redeem") return await redeem(env, await req.json());
      if (req.method === "POST" && p === "/api/report") return await report(env, await req.json());
      const invite = p.match(/^\/i\/([A-Za-z0-9]{4,16})$/);
      if (req.method === "GET" && invite) return html(invitePage(invite[1].toUpperCase()));
      if (req.method === "GET" && p === "/admin") return html(adminHtml.replace("<!-- beayy -->", style));

      if (p.startsWith("/admin/api/")) {
        if (!env.ADMIN_KEY || !sameText(req.headers.get("x-admin-key") || "", env.ADMIN_KEY)) return json({ error: "管理密码不对" }, 401);
        if (req.method === "GET" && p === "/admin/api/seats") return await listSeats(env, url.origin);
        if (req.method === "POST" && p === "/admin/api/seats") return await createSeat(env, await req.json());
        const del = p.match(/^\/admin\/api\/seats\/([A-Z0-9]+)$/);
        if (req.method === "DELETE" && del) return await deleteSeat(env, del[1]);
      }
      if (req.method === "GET" && p === "/") return html(page("localvps", `<h1 class="mx-title">localvps 邀请服务</h1><p>给 <a href="https://github.com/hengfengliya/localvps">localvps</a> 分配固定地址。</p>`));
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },
};
