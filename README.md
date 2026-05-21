# EdgeStash

EdgeStash 是一个单文件 Cloudflare Worker 网盘。核心代码在 `worker.js`，页面、样式、前端交互和后端逻辑都内嵌在这个 Worker 中；文件存储使用 Cloudflare R2，用户、目录缓存、阅读进度和管理员 OTP 状态使用 Workers KV，搜索索引、收藏、最近访问、分享、统计和文件任务使用 Cloudflare D1。

项目当前需要 R2、KV、D1 和 `ADMIN_PASSWORD`，不需要单独构建前端，也不需要额外的运行时服务。

### 备注
Fork来自 https://github.com/hhy-2021/EdgeStash , 做了一些自己需要用的增强

## 在线 Demo

在线体验地址：

```txt
https://s3.chenzhou.dev/
```

测试用户：

```txt
账号：test@test.com
密码：test@test.com
```

测试账号是普通授权用户，只能访问管理员授予的文件或目录，权限以 Demo 环境当前配置为准。

## 产品特性

- 文件管理：上传、下载、删除、重命名、创建文件夹。
- 批量操作：批量复制、移动、删除和打包下载；批量下载由浏览器原生下载 ZIP 压缩包。
- 后台任务：上传、下载、复制、移动和批量删除会进入顶部任务状态栏，可查看进度、历史状态、停止或删除任务。
- 目录浏览：支持中文路径、中文文件名和 KV 目录缓存。
- 搜索：支持按名称或路径即时搜索，可筛选全部、文件、文件夹。
- 收藏和最近访问：支持文件/文件夹收藏、最近访问列表。
- 在线预览：图片、PDF、文本、Markdown、音视频、docx。
- TXT 阅读：支持常见中文编码，并保存阅读进度。
- 分享链接：支持单个或多个文件/目录公开分享、只读目录浏览、可选密码、过期时间、二维码、浏览和下载统计。
- 用户体系：管理员账号和授权用户账号分离。
- 路径权限：可按文件或目录给普通用户授权，支持查看、预览、下载、上传、修改、删除和分享。
- 管理后台：查看统计、管理分享、添加、删除和编辑授权用户。
- 授权选择器：添加或编辑用户时支持搜索文件/目录、多选资源和权限模板。
- 管理员安全：管理员登录需要 `ADMIN_PASSWORD` 加 OTP 一次性验证码。
- OTP 初始化：首次管理员登录会显示二维码和 Secret，二维码由登录页原生 Canvas 生成，不依赖外部 CDN。

## 文件结构

```txt
worker.js    # Cloudflare Worker 主文件，包含后端和内嵌页面
README.md    # 部署和使用说明
imgs/        # 文档展示图片
```

## Cloudflare 资源

部署前需要准备三个 Cloudflare 资源：

| 资源 | Binding 名 | 用途 |
| --- | --- | --- |
| R2 Bucket | `R2_BUCKET` | 保存上传的文件 |
| KV Namespace | `KV_STORE` | 保存用户、目录缓存、阅读进度和管理员 OTP |
| D1 Database | `D1_DB` | 保存搜索索引、收藏、最近访问、分享链接、统计、用户路径权限和文件任务 |

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
7. 添加 D1 binding：
   - 类型：D1 Database
   - Binding name：`D1_DB`
   - Database：选择刚创建的 D1 Database
8. 添加环境变量或 Secret：
   - `ADMIN_PASSWORD=你的强密码`
9. 保存并部署 Worker。
10. 访问 Worker 域名，例如：

```txt
https://your-worker.your-subdomain.workers.dev/
```

## 首次初始化

部署完成后：

1. 打开 `/login.html`。
2. 选择“管理员登录”。
3. 输入 `ADMIN_PASSWORD`，OTP 先留空。
4. Worker 会自动初始化 D1 表结构。如果缺少 `D1_DB` binding，登录会提示 D1 初始化失败。
5. 登录页会显示 OTP 初始化二维码和 Secret。
6. 使用 Google Authenticator、Microsoft Authenticator、1Password 等 App 扫码。
7. 输入 App 中显示的 6 位 OTP，完成绑定并登录。
8. 进入管理后台后，可以创建普通授权用户，并为用户选择可访问的文件或目录。
9. 首次需要使用搜索时，点击页面右上角“刷新”建立 D1 搜索索引。

普通用户登录不需要 OTP，只使用管理员创建的邮箱和密码。

## 用户权限

普通用户不是全盘默认可见，而是只看到管理员授权的文件或目录。管理员在“管理后台 -> 授权用户”里添加或编辑用户时，可以搜索文件/目录、多选资源，并为每个资源设置权限模板或自定义权限。

权限项：

| 权限 | 作用 |
| --- | --- |
| 查看 | 进入目录、在列表和搜索中看到资源 |
| 预览 | 在线打开图片、PDF、文本、Markdown、音视频、docx 等 |
| 下载 | 下载文件或批量打包下载 |
| 上传 | 向目录上传文件或创建文件夹 |
| 修改 | 重命名、移动，或执行需要改动原资源的操作 |
| 删除 | 删除文件或目录 |
| 分享 | 为文件或目录创建公开分享链接 |

内置模板：

| 模板 | 包含权限 |
| --- | --- |
| 只读 | 查看、预览、下载 |
| 可上传 | 查看、预览、下载、上传 |
| 可编辑 | 查看、预览、下载、上传、修改 |
| 完全管理 | 查看、预览、下载、上传、修改、删除、分享 |
| 自定义 | 手动勾选具体权限 |

授权规则：

- 文件授权只作用于单个文件。
- 目录授权会作用于该目录及其子目录。
- 如果同一用户同时命中多个授权路径，路径更具体的授权优先生效。
- 普通用户只会在目录、搜索、收藏和最近访问中看到有“查看”权限的资源。
- 如果只授权了深层目录，用户登录后会在上级目录看到可进入的授权入口，不会暴露未授权资源。
- 管理员不受路径权限限制。

## 重置 OTP 和 D1 初始化状态

如果管理员手机丢失、Authenticator 数据丢失，或需要重新绑定 OTP，需要删除 KV 中的管理员 OTP key。

如果 D1 表结构曾经初始化失败、手动删改过 D1 表，或更换过 D1 数据库，也可以同时删除 D1 初始化标记，让 Worker 下次访问时重新检查并创建表结构。

管理员 OTP 相关 key：

```txt
admin:otp:secret
admin:otp:pending
```

D1 初始化标记 key：

```txt
d1:schema:v1
```

说明：

- `admin:otp:secret` 是已启用的管理员 OTP Secret。
- `admin:otp:pending` 是首次初始化时的临时 Secret，有效期约 10 分钟。
- 如果只删除 `admin:otp:secret`，但 `admin:otp:pending` 还存在，页面可能继续复用旧的临时初始化 Secret。
- 删除 OTP key 后，旧 Authenticator 中的验证码会失效，下一次管理员密码登录会重新显示初始化二维码。
- 删除 `d1:schema:v1` 不会删除 D1 数据，只会让 Worker 下次访问相关 API 时重新执行建表检查。

### 在 Dashboard 里重置

1. 打开 Cloudflare Dashboard。
2. 进入 Workers KV。
3. 选择绑定到 EdgeStash 的 KV Namespace。
4. 按需要搜索并删除：
   - `admin:otp:secret`
   - `admin:otp:pending`
   - `d1:schema:v1`
5. 如果重置了 OTP，回到 `/login.html`，输入管理员密码，重新扫码绑定。

### 用 Wrangler 删除 KV key

在有 `wrangler.toml` 且绑定名为 `KV_STORE` 的项目目录中执行：

```bash
wrangler kv key delete "admin:otp:secret" --binding KV_STORE
wrangler kv key delete "admin:otp:pending" --binding KV_STORE
wrangler kv key delete "d1:schema:v1" --binding KV_STORE
```

如果你更习惯使用 KV namespace ID：

```bash
wrangler kv key delete "admin:otp:secret" --namespace-id YOUR_KV_NAMESPACE_ID
wrangler kv key delete "admin:otp:pending" --namespace-id YOUR_KV_NAMESPACE_ID
wrangler kv key delete "d1:schema:v1" --namespace-id YOUR_KV_NAMESPACE_ID
```

## 日常使用

管理员可以：

- 登录网盘首页。
- 上传、下载、预览和整理文件。
- 使用即时搜索、收藏和最近访问。
- 选中一个或多个文件/目录创建同一个分享链接。
- 进入管理后台查看统计和分享记录。
- 创建、删除授权用户。
- 为用户按文件或目录配置路径权限，支持搜索、多选和权限模板。

普通用户可以：

- 登录网盘首页。
- 在授权范围内使用文件上传、下载、预览、即时搜索、收藏、最近访问和分享等网盘功能。
- 不能进入管理后台。

分享访问者可以：

- 通过 `/s/<shareId>` 访问分享页。
- 在分享未过期且密码正确时浏览只读分享目录。
- 点击目录进入下一级，点击文件直接下载。

## 分享链接

分享入口在文件列表的批量操作栏中。选中 1 个或多个文件/目录后点击“分享”，可以为这些项目创建同一个公开链接。

当前分享行为：

- 分享页是只读文件视图，不允许访客上传、重命名、移动或删除。
- 分享根目录会显示创建分享时选中的所有项目。
- 分享文件时，访客点击文件直接下载。
- 分享目录时，访客可以进入该目录及其子目录，并下载目录内文件。
- 混合选择文件和目录时，根视图会同时显示这些文件和目录。
- 密码保护和过期时间对浏览目录和下载文件都生效。
- 下载接口会校验目标路径，只允许下载分享范围内的文件。
- 旧版单文件分享链接仍会按一个分享项目自动兼容。

相关接口：

| 接口 | 作用 |
| --- | --- |
| `POST /api/share` | 创建分享。支持新版 `{ items: [...] }`，也兼容旧版 `{ filePath }` |
| `GET /api/share/:id` | 获取分享基础信息 |
| `POST /api/share/:id/list` | 列出分享根目录或分享目录内项目 |
| `POST /api/share/:id/download` | 下载分享范围内的指定文件 |

## 后台任务和下载

上传、下载、复制、移动和批量删除都会创建文件任务，任务记录保存在 D1 中。页面顶部会在“刷新 / 管理后台”旁显示任务状态入口，点击后可以查看最近任务、状态、失败原因，并对任务执行停止或删除。

当前任务行为：

- 上传：使用浏览器上传连接，前端通过 `XMLHttpRequest.upload.onprogress` 写入真实上传字节进度；默认同时上传 2 个文件，其余排队。
- 下载：交给浏览器原生下载，不由前端先读完整文件再保存；任务状态只显示“处理中”或“已开始”，不显示浏览器下载栏里的字节进度。
- 批量下载：浏览器原生下载 Worker 生成的 ZIP 压缩包；服务端会为 ZIP 响应写入 `Content-Length`。
- 复制、移动和批量删除：先创建任务和任务项，再由前端后台分片调用服务端处理；任务面板显示已处理数量。
- 停止任务：会把任务标记为已取消，并中止当前页面内仍在进行的上传连接；已经交给浏览器原生下载的文件下载由浏览器管理。
- 删除任务：只删除任务记录和任务项，不删除已经上传、下载、复制/移动或删除完成的文件。

注意事项：

- D1 中的任务记录能在刷新页面后继续显示。
- 浏览器关闭后，上传连接不会继续；旧的上传/下载任务会在超时后标记失败。
- 复制、移动和批量删除任务可以在页面重新打开后继续由前端分片推进。

## 缓存和刷新

目录列表会缓存到 KV，以减少频繁读取 R2。搜索索引、收藏、最近访问、分享链接、统计、用户路径权限和文件任务保存在 D1。

当前缓存逻辑：

- 打开目录时，先读取 KV 中的 `cache:dir:<目录路径>`。
- KV 命中时直接返回目录列表，不会请求 R2。
- KV 未命中时才会调用 R2 `list` 读取当前目录，并把结果写回 KV。
- 搜索框输入时查询 D1 的 `search_items`，不会直接请求 R2。
- 添加或编辑用户授权时，文件/目录搜索同样使用 D1 的 `search_items`。
- 新部署或 D1 被清空后，搜索索引为空，需要点击一次“刷新”建立索引。
- 收藏和最近访问只读写 D1，不会直接请求 R2。
- 上传、新建文件夹、删除、重命名、复制、移动会操作 R2，并清理相关 KV 缓存。
- 删除、重命名、移动会清理 D1 中旧路径对应的搜索、收藏和最近访问记录。

页面右上角的“刷新”会做两件事：

1. 重新读取当前目录并刷新 KV 目录缓存。
2. 重建 D1 搜索索引，扫描 R2 中的全部对象。

因此，“刷新”适合在发现目录或搜索结果不一致时手动使用，不建议频繁点击。日常打开已缓存目录和即时搜索不会重复扫描 R2。

如果你只想手动清理某个目录缓存，也可以在 KV 中删除对应 key，例如：

```txt
cache:dir:/
cache:dir:/资料
```

D1 表结构由 Worker 自动创建，当前会使用这些表：

```txt
search_items
favorites
recent_items
share_links
share_items
app_stats
user_permissions
file_tasks
file_task_items
```

首次访问相关 API 时会初始化表结构，并在 KV 写入 `d1:schema:v1` 作为已初始化标记。

## 运维建议

- `ADMIN_PASSWORD` 请使用强随机密码。
- 请妥善保存管理员 OTP 的恢复方式；丢失后需要 Cloudflare 后台或 Wrangler 权限才能重置。
- 定期清理过期或不再需要的分享链接。
- 大量文件操作后，如果目录或搜索结果显示异常，再使用页面刷新功能。
- R2 请求会产生 Cloudflare 用量。已缓存目录浏览、即时搜索、收藏、最近访问主要走 KV/D1；刷新、首次打开未缓存目录、大目录删除/移动/重命名、预览和下载会访问 R2。
- 如果开放给多人上传，建议对 Markdown/docx 预览内容做额外安全审查。
- R2 和 KV 都会产生 Cloudflare 用量，请根据实际文件规模和访问量关注账单。

## 常见问题

### 为什么第一次管理员登录需要 OTP？

管理员账号拥有用户管理、分享管理和统计查看权限。当前版本要求管理员密码和 OTP 同时正确，降低密码泄露后的风险。

### 二维码不显示怎么办？

当前版本二维码由登录页原生 Canvas 生成，不依赖外部 CDN。若页面仍未显示二维码，请确认已经部署最新版 `worker.js`，并强制刷新浏览器缓存。页面也会同时显示 Secret，可以在 Authenticator 中手动输入 Secret 添加。

### 删除 `admin:otp:secret` 后为什么没有出现新的二维码？

请同时删除 `admin:otp:pending`。临时初始化 Secret 可能仍在 10 分钟有效期内。

### 当前目录不显示文件，控制台报 `Unexpected token 'if'` 怎么办？

这通常是线上 Worker 仍在运行旧版页面模板，或手动粘贴部署时改坏了内嵌脚本中的正则转义。先确认 Cloudflare Worker 中部署的是当前仓库的完整 `worker.js`，保存后强制刷新浏览器缓存。

如果你在旧代码里看到类似这一行：

```js
normalized = normalized.replace(//+/g, '/');
```

需要改成：

```js
normalized = normalized.replace(/[/]+/g, '/');
```

当前仓库版本已不包含这段旧逻辑；如果重新部署当前 `worker.js` 后仍然目录为空，再检查 `R2_BUCKET`、`KV_STORE`、`D1_DB` binding 是否配置正确，以及普通用户是否已经授权了可访问目录。

### 需要 D1 吗？

需要。当前版本使用 D1 保存搜索索引、收藏、最近访问、分享链接、统计、用户路径权限和文件任务，binding 名固定为 `D1_DB`。相关表由 `worker.js` 首次访问相关 API 时自动创建。

### 搜索会不会频繁请求 R2？

不会。搜索框是即时搜索，但查询的是 D1 搜索索引。只有点击页面右上角“刷新”时，才会重建搜索索引并扫描 R2 全部对象。

### 为什么刷新会消耗更多请求？

刷新会重新读取当前目录，并重建 D1 搜索索引。重建索引需要通过 R2 `list` 扫描桶内对象，文件越多，请求越多。平时目录命中 KV 缓存、搜索命中 D1 时不会这样扫描。

### 搜索结果不更新怎么办？

如果刚做过大量上传、删除、重命名或移动，搜索索引可能还保留旧结果。点击页面右上角“刷新”会重建索引。刷新完成后，搜索结果会以 D1 中的新索引为准。

## 参考

- Cloudflare Wrangler `deploy` 命令： https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
- Cloudflare Wrangler 文档： https://developers.cloudflare.com/workers/wrangler/
