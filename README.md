# EdgeStash

EdgeStash 是一个基于 Cloudflare Worker + R2 + KV 的轻量级云盘（Cloud Drive）实现。该仓库的核心逻辑在 `worker.js` 中，包含文件存储、目录缓存、用户认证（管理员 + 授权用户）、分享链接与预览功能。

## 主要特性

- 基于 Cloudflare R2 存储文件
- 使用 KV 作为元数据/缓存存储
- 管理员登录（使用环境变量 ADMIN_PASSWORD）与授权用户（存储于 KV）
- 文件上传、下载、删除、重命名、文件夹创建
- 目录列表缓存（KV），支持手动刷新与自动失效
- 分享链接功能，支持密码保护与有效期（1h / 1d / 1m / permanent）
- 在线预览：图片、PDF、文本/代码、视频、音频、docx（使用 Mammoth.js 客户端库）
- 内置简单前端页面（登录、主页面、管理后台、分享页），已内嵌在 worker 中
- 支持跨域预检（OPTIONS）与基本 CORS 头

## 部署指南与步骤

下面给出在 Cloudflare 上部署本项目的建议步骤，包括通过 Cloudflare Dashboard 和 wrangler 两种方式。

必要条件：
- 一个 Cloudflare 账号，且有权限创建 Workers、R2 Bucket、KV 命名空间。
- 已安装 wrangler（可选，用于命令行部署）：
  - 安装：`npm install -g wrangler@latest`
  - 登录：`wrangler login`

步骤一（在 Cloudflare Dashboard 中完成，适合 UI 操作）：
1. 创建 R2 Bucket：进入 Workers & R2 → R2 → Create bucket，记住 bucket 名称。
2. 创建 KV 命名空间：Workers → KV → Create namespace，记下命名空间 ID。
3. 创建 Worker：Workers → Create a Worker，新建或编辑现有 Worker。
4. 在 Worker 的 Settings → Variables & secrets 中添加绑定：
   - 在 `Variables (Bindings)` 中添加 R2 绑定：
     - 类型：R2
     - Binding name（变量名）：`R2_BUCKET`（或你在代码中使用的名称）
     - Bucket：选择刚创建的 R2 Bucket。
   - 在 `Variables (Bindings)` 中添加 KV 绑定：
     - 类型：KV Namespace
     - Binding name：`KV_STORE`（或代码中使用的名称）
     - Namespace：选择刚创建的 KV 命名空间。
5. 在 Secrets / Variables 中添加管理员密码（或更安全的 JWT_SECRET）：
   - `ADMIN_PASSWORD`：设置为强随机密码。
   - 推荐：新增 `JWT_SECRET` 并在代码中替换签名密钥（提高安全性）。
6. 将 `worker.js` 的代码粘贴到 Worker 编辑器（或通过 wrangler 上传），保存并部署。
7. 配置 Worker 路由或直接使用 Worker 的二级域名进行访问。

步骤二（使用 wrangler 命令行部署，适合 CI/CD）：
1. 在 Cloudflare 控制台创建 R2 bucket 与 KV namespace（参考步骤一第1、2步）。记录 R2 的 bucket 名称与 KV namespace ID。
2. 在项目根目录创建 `wrangler.toml`，示例：

```toml
name = "edge-stash"
type = "javascript"
account_id = "YOUR_ACCOUNT_ID"
workers_dev = true

[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "your-r2-bucket-name"

[[kv_namespaces]]
binding = "KV_STORE"
# 下面替换为你在控制台创建的命名空间 ID
id = "YOUR_KV_NAMESPACE_ID"
```

3. 登录 wrangler：

```bash
wrangler login
```

4. 将敏感变量作为 secret 或环境变量注入：

```bash
wrangler secret put ADMIN_PASSWORD
# 推荐：
wrangler secret put JWT_SECRET
```

5. 发布 Worker：

```bash
wrangler publish
```

6. 如果 `workers_dev = false`，你可以在 `wrangler.toml` 中配置自定义域名与路由（详见 wrangler 文档）。

注意事项（R2 / KV 权限与绑定）：
- 在 `wrangler.toml` 中，`[[r2_buckets]]` 的 `bucket_name` 要与控制台中的 R2 bucket 名一致，`binding` 要与代码中使用的变量名一致（代码中为 `R2_BUCKET`）。
- KV 命名空间在创建后会返回一个 ID，将 ID 写入 `wrangler.toml` 的 `[[kv_namespaces]]` 部分。
- 如果通过 Dashboard 直接绑定，确保 Binding name 与代码一致。

步骤三 —— 部署后测试与初始化：
1. 访问 Worker 地址 `/login.html`，使用管理员密码登录并确认能成功设置 `token` cookie（HttpOnly）。
2. 使用管理员登录后的接口创建授权用户（POST `/api/admin/users`）。
3. 在 R2 中上传一个测试文件（通过前端上传或直接 R2 上传），访问 `/api/files/` 检查目录列出是否正常。
4. 测试分享：通过 POST `/api/share` 创建分享并访问 `/s/{shareId}` 页面，测试下载（含密码/过期逻辑）。
5. 测试预览：上传图片、PDF、文本、docx 等文件，使用前端预览功能检查是否正常。

可选：把前端静态页面拆分出来
- 当前实现将 HTML/CSS/JS 内嵌到 `worker.js` 中，维护不便。建议将前端文件拆分到单独静态站点（如 Cloudflare Pages、GitHub Pages 或 CDN），并把 Worker 仅作为 API 层，能简化部署与开发。

故障排查提示
- 如果目录列表为空但 R2 已有对象，确认 `directoryPathToR2Prefix` 的前缀映射是否一致，R2 对象 key 是否含有前导斜杠（代码中不应带前导斜杠）。
- 若 KV 缓存不生效，检查 `KV_STORE` 绑定是否正确以及 KV 是否有读写权限。
- 若预览或下载命名出现乱码，确认浏览器对 Content-Disposition 的处理与文件名编码（代码已使用 RFC5987 方式设置 filename*）。


## 运行环境与绑定

在 Cloudflare Workers Dashboard 中部署本 Worker 时，请配置下列环境变量与绑定：

- 环境变量（Environment Variables）
  - `ADMIN_PASSWORD`：管理员密码（也被用作 JWT 签名密钥）。

- 绑定（Bindings）
  - `R2_BUCKET`：R2 bucket 的 binding 名称，用于存储文件
  - `KV_STORE`：KV 命名空间的 binding 名称，用于存储用户、分享信息与目录缓存

注意：仓库中代码假定 binding 名称为 `R2_BUCKET` 与 `KV_STORE`，如需修改请同步修改 worker 的绑定或代码。

## 重要实现细节

- 登录与认证
  - 管理员登录：POST /api/login 带 `isAdmin: true`，直接使用 `ADMIN_PASSWORD` 校验。
  - 授权用户登录：POST /api/login 带 `isAdmin: false`、`email` 与 `password`，用户记录以 `user:<email>` 存在 KV 中，密码以 SHA-256 哈希存储。
  - 认证使用简单 JWT（HS256），签名使用 `ADMIN_PASSWORD`。生成的 token 通过 `Set-Cookie` 写入 `token`（HttpOnly，SameSite=Strict，默认 24h）。

- 文件存储与路径
  - R2 中的对象 key 对应仓库内的文件路径（以不带前导 `/` 的形式存储）。
  - 目录通过在 R2 创建占位文件 `.../.folder` 来表示（创建文件夹时会 put 一个空 `.folder`）。
  - 前端与 API 之间路径通过安全解码 `safeDecodePath` 处理，避免中文或编码问题。

- 目录缓存（KV）
  - 使用前缀 `cache:dir:` 存储目录缓存，读取列目录时优先读取 KV 缓存，支持手动刷新 `/api/cache/refresh`。
  - 当文件被新增、删除、重命名时，会尝试删除或刷新父目录的缓存以保持一致性。

- 分享（Share）
  - 创建分享：POST /api/share，返回 shareId（12 位随机字符串）与分享 URL `/s/{shareId}`。分享信息保存在 KV：`share:{shareId}`。
  - 分享支持可选密码（存储为 SHA-256 哈希）与过期时间（`1h`, `1d`, `1m`, `permanent`）。
  - 下载分享文件：POST /api/share/{id}/download（如果有密码则需在 body 中提供 `password`）。

- 预览
  - 代码中会根据扩展名判断 `previewType`（image、pdf、text、word、video、audio）。
  - docx 在线预览依赖客户端的 Mammoth.js；Markdown 使用 `marked`（客户端）。

- 管理 API
  - 获取统计：GET /api/admin/stats（仅管理员）
  - 分享列表：GET /api/admin/shares（仅管理员）
  - 删除分享：DELETE /api/admin/shares/{shareId}（仅管理员）
  - 用户管理：GET /api/admin/users、POST /api/admin/users（创建）、DELETE /api/admin/users/{email}（仅管理员）

## HTTP 路由（摘要）

- 静态页面
  - `/` 或 `/index.html`：主页面（需要登录）
  - `/login.html`：登录页面
  - `/admin.html`：管理面板（需要管理员权限）
  - `/s/{shareId}`：分享页面（公开访问）

- API 路径
  - POST `/api/login`  登录（管理员或普通用户）
  - POST `/api/logout` 登出（清除 cookie）
  - GET `/api/auth/check` 检查当前 token 状态

  - 文件与目录
    - GET `/api/files{path}` 列表（path 可空或 `/` 起头）
    - POST `/api/files{path}` 上传文件（FormData，字段名 `file`）
    - PUT `/api/files{path}` 重命名（body: { newName })
    - DELETE `/api/files{path}` 删除文件或文件夹（递归）
    - POST `/api/folders` 创建文件夹（body: { path })

  - 下载与预览
    - GET `/api/download{path}` 下载（需要认证）
    - GET `/api/preview{path}` 预览（需要认证，支持 Range）

  - 分享
    - POST `/api/share` 创建分享（body: { filePath, password?, expiresIn? })
    - GET `/api/share/{id}` 获取分享信息
    - POST `/api/share/{id}/download` 下载分享文件（如果设置了密码需带 password）

  - 管理（仅管理员）
    - GET `/api/admin/stats`
    - GET `/api/admin/shares`
    - DELETE `/api/admin/shares/{id}`
    - GET `/api/admin/users`
    - POST `/api/admin/users`（body: { email, password }）
    - DELETE `/api/admin/users/{email}`

  - 缓存管理
    - POST `/api/cache/refresh` 刷新指定目录缓存（body: { path })

## Cookie / Token

- 名称：`token`
- 属性：HttpOnly, SameSite=Strict, Path=/, Max-Age=86400（默认 24 小时）
- JWT payload 中包含 `role` （`admin` 或 `user`），`email`（普通用户），以及 `exp`（到期时间戳）。
- 注意：代码当前使用 `ADMIN_PASSWORD` 作为 JWT 签名密钥 —— 如果要更安全，请将 JWT secret 单独配置为不同环境变量。

## 部署建议与安全提示

- 强烈建议使用强且随机的 `ADMIN_PASSWORD`。
- 生产环境请将 JWT 签名密钥与管理员密码分离（即新增一个单独的 SECRET 环境变量作为 JWT secret）。
- R2 对象 key 与客户端可见的路径有关，请在文件名/路径策略上做好限制，避免任意写入导致覆盖重要文件。
- 若需要对外开放分享下载接口，请注意带宽与权限控制。

## 调试与常见操作示例

- 列目录（默认根目录）

curl -i -X GET "https://your-worker.example.com/api/files/"

- 上传文件（单文件）

curl -i -X POST "https://your-worker.example.com/api/files/" -F "file=@./localfile.png" --cookie "token=YOURTOKEN"

- 创建分享链接（需认证）

curl -i -X POST "https://your-worker.example.com/api/share" \
  -H "Content-Type: application/json" \
  --cookie "token=YOURTOKEN" \
  -d '{"filePath":"/path/to/file.png","password":"1234","expiresIn":"1d"}'

- 通过分享链接下载

curl -i -X POST "https://your-worker.example.com/api/share/SHAREID/download" -d '{"password":"1234"}'

## 限制与已知问题

- 本实现为简单示例，前端页面与 JS 在 worker 中以字符串内嵌，存在维护不便的问题；建议把前端分离到静态站点或仓库中的独立文件以便维护。
- 代码里有对某些文本/编码做了容错处理，但在极端编码情况下仍可能出现问题。
- 当文件数量巨大时，R2 列表与 KV 操作可能会有分页/性能影响，请按需优化（例���使用分页列出目录或限制单目录对象数）。

## 我在代码中看到的重要点（来自最新的 worker.js）

- JWT 使用 HS256（通过 Web Crypto HMAC-SHA256）手动实现。
- 目录缓存前缀：`cache:dir:`，并提供了递归删除缓存的工具函数。
- 预览类型检测在后端实现（getPreviewType），支持图片、pdf、文本、docx、视频和音频等。
- 创建文件夹是通过在 R2 写入占位 `.folder` 完成。
- 分享统计（总分享数、总浏览、总下载）会存储并更新在 KV 下 `stats:*`。

---

如果你愿意，我可以：
- 把内嵌的 HTML/JS/CSS 分离成独立静态文件并提交为新文件（更易维护）；
- 或者把 README 里某些示例补充为更详细的部署步骤（Terraform / wrangler 配置示例）。
