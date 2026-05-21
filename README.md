# EdgeStash

EdgeStash 是一个单文件 Cloudflare Worker 网盘。核心代码在 `worker.js`，页面、样式、前端交互和后端逻辑都内嵌在这个 Worker 中；文件存储使用 Cloudflare R2，用户、分享、统计、目录缓存和管理员 OTP 状态使用 Workers KV。

项目当前不需要 D1，不需要单独构建前端，也不需要额外的运行时服务。

### 备注
Fork来自 https://github.com/hhy-2021/EdgeStash , 做了一些自己需要用的增强

## 产品特性

- 文件管理：上传、下载、删除、重命名、创建文件夹。
- 批量操作：批量复制、移动、删除和打包下载。
- 目录浏览：支持中文路径、中文文件名和目录缓存。
- 在线预览：图片、PDF、文本、Markdown、音视频、docx。
- TXT 阅读：支持常见中文编码，并保存阅读进度。
- 分享链接：支持公开分享、可选密码、过期时间、浏览和下载统计。
- 用户体系：管理员账号和授权用户账号分离。
- 管理后台：查看统计、管理分享、添加和删除授权用户。
- 管理员安全：管理员登录需要 `ADMIN_PASSWORD` 加 OTP 一次性验证码。
- OTP 初始化：首次管理员登录会显示二维码和 Secret，二维码由 Worker 后端生成，不依赖外部 CDN。

## 文件结构

```txt
worker.js    # Cloudflare Worker 主文件，包含后端和内嵌页面
README.md    # 部署和使用说明
readme.md    # 中文说明副本
imgs/        # 文档展示图片
```

## Cloudflare 资源

部署前需要准备两个 Cloudflare 资源：

| 资源 | Binding 名 | 用途 |
| --- | --- | --- |
| R2 Bucket | `R2_BUCKET` | 保存上传的文件 |
| KV Namespace | `KV_STORE` | 保存用户、分享、统计、目录缓存和管理员 OTP |

环境变量：

| 变量名 | 用途 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员密码，也是当前 JWT 签名密钥 |

Binding 名必须和代码一致。如果你改了 binding 名，需要同步改 `worker.js`。

## Dashboard 部署流程

1. 进入 Cloudflare Dashboard，创建一个 R2 Bucket。
2. 创建一个 KV Namespace。
3. 创建一个 Worker。
4. 将 `worker.js` 的完整内容粘贴到 Worker 编辑器。
5. 在 Worker 设置中添加 R2 binding：
   - 类型：R2 Bucket
   - Binding name：`R2_BUCKET`
   - Bucket：选择刚创建的 R2 Bucket
6. 添加 KV binding：
   - 类型：KV Namespace
   - Binding name：`KV_STORE`
   - Namespace：选择刚创建的 KV Namespace
7. 添加环境变量或 Secret：
   - `ADMIN_PASSWORD=你的强密码`
8. 保存并部署 Worker。
9. 访问 Worker 域名，例如：

```txt
https://your-worker.your-subdomain.workers.dev/
```

## Wrangler 部署流程

安装并登录 Wrangler：

```bash
npm install -g wrangler
wrangler login
```

在项目根目录创建 `wrangler.toml`：

```toml
name = "edge-stash"
main = "worker.js"
compatibility_date = "2026-05-21"
workers_dev = true

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "your-r2-bucket-name"

[[kv_namespaces]]
binding = "KV_STORE"
id = "your-kv-namespace-id"
```

设置管理员密码：

```bash
wrangler secret put ADMIN_PASSWORD
```

部署：

```bash
wrangler deploy
```

如果不使用 `wrangler.toml`，也可以指定入口文件：

```bash
wrangler deploy worker.js --name edge-stash
```

## 首次初始化

部署完成后：

1. 打开 `/login.html`。
2. 选择“管理员登录”。
3. 输入 `ADMIN_PASSWORD`，OTP 先留空。
4. 登录页会显示 OTP 初始化二维码和 Secret。
5. 使用 Google Authenticator、Microsoft Authenticator、1Password 等 App 扫码。
6. 输入 App 中显示的 6 位 OTP，完成绑定并登录。
7. 进入管理后台后，可以创建普通授权用户。

普通用户登录不需要 OTP，只使用管理员创建的邮箱和密码。

## 重置管理员 OTP

如果管理员手机丢失、Authenticator 数据丢失，或需要重新绑定 OTP，需要删除 KV 中的管理员 OTP key。

建议同时删除这两个 key：

```txt
admin:otp:secret
admin:otp:pending
```

说明：

- `admin:otp:secret` 是已启用的管理员 OTP Secret。
- `admin:otp:pending` 是首次初始化时的临时 Secret，有效期约 10 分钟。
- 如果只删除 `admin:otp:secret`，但 `admin:otp:pending` 还存在，页面可能继续复用旧的临时初始化 Secret。
- 删除后，旧 Authenticator 中的验证码会失效，下一次管理员密码登录会重新显示初始化二维码。

### 在 Dashboard 重置

1. 打开 Cloudflare Dashboard。
2. 进入 Workers KV。
3. 选择绑定到 EdgeStash 的 KV Namespace。
4. 搜索并删除：
   - `admin:otp:secret`
   - `admin:otp:pending`
5. 回到 `/login.html`，输入管理员密码，重新扫码绑定。

### 用 Wrangler 重置

在有 `wrangler.toml` 且绑定名为 `KV_STORE` 的项目目录中执行：

```bash
wrangler kv key delete "admin:otp:secret" --binding KV_STORE
wrangler kv key delete "admin:otp:pending" --binding KV_STORE
```

如果你更习惯使用 KV namespace ID：

```bash
wrangler kv key delete "admin:otp:secret" --namespace-id YOUR_KV_NAMESPACE_ID
wrangler kv key delete "admin:otp:pending" --namespace-id YOUR_KV_NAMESPACE_ID
```

## 日常使用

管理员可以：

- 登录网盘首页。
- 上传、下载、预览和整理文件。
- 创建分享链接。
- 进入管理后台查看统计和分享记录。
- 创建、删除授权用户。

普通用户可以：

- 登录网盘首页。
- 使用文件上传、下载、预览和分享等基础网盘功能。
- 不能进入管理后台。

分享访问者可以：

- 通过 `/s/<shareId>` 访问分享页。
- 在分享未过期且密码正确时下载文件。

## 缓存和刷新

目录列表会缓存到 KV，以减少频繁读取 R2。文件上传、删除、重命名、移动等操作会尽量自动刷新相关缓存。

如果你发现目录显示和 R2 实际内容不一致，可以在页面右上角点击“刷新”。也可以在 KV 中删除对应目录缓存 key，例如：

```txt
cache:dir:/
cache:dir:/资料
```

## 运维建议

- `ADMIN_PASSWORD` 请使用强随机密码。
- 请妥善保存管理员 OTP 的恢复方式；丢失后需要 Cloudflare 后台或 Wrangler 权限才能重置。
- 定期清理过期或不再需要的分享链接。
- 大量文件操作后，如果目录显示异常，先使用页面刷新功能。
- 如果开放给多人上传，建议对 Markdown/docx 预览内容做额外安全审查。
- R2 和 KV 都会产生 Cloudflare 用量，请根据实际文件规模和访问量关注账单。

## 常见问题

### 为什么第一次管理员登录需要 OTP？

管理员账号拥有用户管理、分享管理和统计查看权限。当前版本要求管理员密码和 OTP 同时正确，降低密码泄露后的风险。

### 二维码不显示怎么办？

当前版本二维码由 Worker 后端生成 SVG，不依赖外部 CDN。若页面仍未显示二维码，请确认已经部署最新版 `worker.js`，并强制刷新浏览器缓存。页面也会同时显示 Secret，可以在 Authenticator 中手动输入 Secret 添加。

### 删除 `admin:otp:secret` 后为什么没有出现新的二维码？

请同时删除 `admin:otp:pending`。临时初始化 Secret 可能仍在 10 分钟有效期内。

### 需要 D1 吗？

不需要。当前版本只依赖 R2、KV 和 `ADMIN_PASSWORD`。

## 参考

- Cloudflare Wrangler `deploy` 命令： https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
- Cloudflare Wrangler 文档： https://developers.cloudflare.com/workers/wrangler/
