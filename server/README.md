# localvps 邀请服务

一个 Cloudflare Worker。你在管理页给别人发邀请链接，对方在 localvps「设置 → 网络 → 隧道 → 邀请码」里粘贴，就会：

1. 分到一个固定地址 `名字.你的域名`（Worker 替你建好 Cloudflare 远端托管隧道和 DNS 记录）
2. 每 5 分钟，以及令牌、权限、隧道状态变化时，向这个服务上报地址、权限、访问令牌、版本
3. 你在 `/admin` 里看到每台电脑在不在线（以隧道连接为准），一键复制 `claude mcp add` 接入命令

对方在别的电脑上重新填同一个邀请码，旧电脑的绑定立即失效；你在管理页「收回」会删掉隧道和域名。

## 部署

需要一个托管在 Cloudflare 的域名。

1. 改 `wrangler.jsonc`：`routes` 里的服务地址、`vars` 里的 `DOMAIN`、`ZONE_ID`、`ACCOUNT_ID`
2. 建 KV，把 id 填进 `kv_namespaces`：

   ```bash
   npx wrangler@4 kv namespace create localvps-hub
   ```

3. 部署并设置两个密钥：

   ```bash
   npx wrangler@4 deploy
   npx wrangler@4 secret put CF_API_TOKEN   # 要有：账号 Cloudflare Tunnel 编辑、该域名 DNS 编辑
   npx wrangler@4 secret put ADMIN_KEY      # 管理页密码，自己生成一个长随机串
   ```

4. 打开 `https://服务地址/admin`，输入管理密码，填名字生成邀请链接

## 接口

| 路径 | 用途 |
|---|---|
| `GET /i/<邀请码>` | 邀请链接本身，浏览器打开是填写说明 |
| `POST /api/redeem` | localvps 填邀请码：返回固定地址、隧道令牌、上报密钥 |
| `POST /api/report` | localvps 定时上报 |
| `GET /admin` | 管理页；`/admin/api/*` 要 `x-admin-key` 头 |

数据存在 KV 的 `seat:<邀请码>` 里，包括对方的访问令牌：管理密码和 `CF_API_TOKEN` 要保管好。
