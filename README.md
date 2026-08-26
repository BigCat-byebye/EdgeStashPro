# EdgeStashPro

EdgeStashPro 是一个运行在 Cloudflare Workers 上的多存储云盘。项目已经从早期的单文件 Worker 演进为多模块源码：Worker 入口、认证、D1 数据模型、S3 适配器、同步任务和页面模板分别维护。

作者维护和验收使用隔离的 `-dev` 环境：

- Worker：`edgestash-dev`
- D1：`edgestash-d1-dev`
- KV：`edgestash-kv-dev`
- 可选的开发 R2 桶：`edgestash-storage-dev`

公开自托管部署使用通用的 `wrangler.jsonc` 和 README 中的 Deploy to Cloudflare 按钮；它不会复用作者的 `-dev` 资源。生产 Worker、生产 D1、生产 KV 和生产存储不属于作者当前的验收部署路径。不要把任何真实生产资源 ID、Secret 或凭证写入仓库。

![预览图片](merged-images.png)

## 在线 Demo

在线体验地址：

```txt
https://s3.zxhf.dev/
```

Demo credentials are intentionally not included in this repository. Use only credentials provided through the Demo's own onboarding channel, and never reuse them for a real deployment.

## 重大架构变化

### 旧结构

早期版本主要依赖：

```txt
worker.js
wrangler.toml
R2_BUCKET binding
```

后端、页面、样式和前端脚本全部嵌在一个 `worker.js` 中。

### 当前结构

现在的 Worker 入口是 `src/index.js`，不再存在根目录 `worker.js`，也不再使用 `wrangler.toml.example` 或生产部署脚本。

```txt
src/
├── index.js                 Worker fetch/scheduled 入口、路由和业务 API
├── common.js                路径、响应、JWT、密码哈希、OTP、MIME 等公共函数
├── auth.js                  管理员/普通用户登录、OTP、JWT 会话
├── admin.js                 管理员 API：用户、分享、统计和存储管理
├── db/
│   ├── schema.js            D1 运行时迁移和表结构
│   └── catalog.js            D1 目录、搜索和资源模型
├── storage/
│   ├── s3.js                唯一的 S3 SigV4 适配器
│   ├── credentials.js       存储凭证 AES-256-GCM 加解密
│   ├── repository.js        动态存储连接仓库
│   ├── service.js            存储连接业务操作
│   └── sync.js               可恢复的远端扫描和同步任务
└── pages/
    ├── login.js              登录页模板和交互
    ├── index.js              云盘首页模板和交互
    ├── admin.js              管理后台模板和交互
    ├── share.js              分享页模板和交互
    ├── styles.js             共享样式
    └── theme.js              主题初始化和切换

scripts/
├── provision-dev.mjs         创建/复用隔离的 -dev 资源并写入 wrangler.dev.jsonc

├── init-dev-secrets.mjs      首次生成 .dev.vars 中的开发 Secret
├── assert-dev-config.mjs     部署前的 dev-only 安全门禁
├── deploy-dev.mjs            初始化 Secret、检查配置并部署 edgestash-dev
└── verify-dev.mjs            校验配置、版本、URL 和登录页

test/
├── regression.mjs            Worker、认证、权限、分享、TXT 和 D1 热路径回归
├── storage.mjs               S3、加密、SigV4、Range 和流式 I/O 回归
├── sync.mjs                  多存储同步隔离和分页回归
├── lifecycle.mjs              迁移、存储生命周期和凭证安全回归
└── explore-reader-jump.mjs   阅读器诊断脚本
```

页面仍然是原生 HTML/CSS/JavaScript 模板，不引入 React、Hono、TypeScript 或独立前端构建产物。

## 产品能力

- 文件管理：上传文件、上传文件夹、下载、删除、重命名、创建文件夹。
- 批量操作：复制、移动、删除、ZIP 打包下载和任务进度。
- 多存储：管理员可以动态配置多个 S3 兼容存储，并在首页和后台切换当前存储。
- 存储隔离：目录、搜索、标签、收藏、最近访问、TXT 阅读、分享和权限均带 `storage_id` 作用域。
- S3 适配器：统一处理 ListObjectsV2、Head、Get、Range、Put、Copy、Delete 和 SigV4。
- 远端同步：手工刷新和 Cron 扫描都进入可恢复的 D1 同步作业，不在目录浏览时直接扫描远端。
- 搜索：按名称、路径、类型和标签搜索。
- TXT 阅读：支持常见中文编码、正文索引、分片读取、跨设备阅读进度和书签。
- 在线预览：图片、PDF、文本、Markdown、音视频和 docx。
- 分享链接：支持多文件/目录、密码、过期时间、只读目录浏览、二维码、浏览和下载统计。
- 用户权限：管理员可以按文件或目录授权普通用户，并配置查看、预览、下载、上传、修改、删除和分享权限。
- 管理后台：统计、分享链接、授权用户、存储连接和同步任务。
- 日间/夜间模式：登录页、云盘、后台和分享页均支持主题切换。

## Cloudflare 资源和绑定

`wrangler.jsonc` 是面向 Deploy to Cloudflare 的通用配置，只声明 D1、KV 和 Cron，不声明 R2 binding：

| 资源 | 默认名称/来源 | Binding | 用途 |
| --- | --- | --- | --- |
| Worker | 部署配置页选择 | — | 单个 Worker 入口 `src/index.js` |
| D1 | `edgestashpro-db` | `D1_DB` | 目录、搜索、权限、分享、任务和存储元数据 |
| KV | Cloudflare 自动创建 | `KV_STORE` | 用户账号、管理员 OTP、旧阅读状态迁移 |
| R2 | 不自动绑定 | 无 | 通过管理后台作为 S3 兼容后端配置 |

作者开发和验收使用单独的资源：

| 资源 | 名称 | Binding |
| --- | --- | --- |
| Worker | `edgestash-dev` | — |
| D1 | `edgestash-d1-dev` | `D1_DB` |
| KV | `edgestash-kv-dev` | `KV_STORE` |
| R2 | `edgestash-storage-dev` | 无，作为 S3 后端 |

R2 不再通过 `R2_BUCKET` binding 直接访问。Cloudflare R2、AWS S3、阿里云 OSS、腾讯云 COS、MinIO 等服务都通过 S3 兼容接口配置到后台。

### Secret

| Secret | 用途 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员密码，同时作为 JWT 签名密钥 |
| `STORAGE_CONFIG_KEY` | AES-256-GCM 加密动态存储凭证 |

存储连接的 Access Key、Secret Key 和 Session Token 只保存加密后的密文；API、列表、日志和错误响应不会返回原始凭证。

## 本地准备

要求 Node.js 22 或更高版本：

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

如果是首次配置开发环境，先创建或复用隔离资源：

```bash
npm run provision:dev
```

该脚本只允许处理以下资源名：

```txt
edgestash-dev
edgestash-d1-dev
edgestash-kv-dev
edgestash-storage-dev
```

它会把 D1/KV ID 写入被忽略的 `wrangler.dev.jsonc`，不会删除或复用非 `-dev` 资源。


## 开发和部署命令

### 本地开发

```bash
npm run dev
```

该命令会在缺少 `.dev.vars` 时生成开发 Secret，然后启动 Wrangler 本地 Worker，并启用 scheduled 测试入口。默认使用本地 Wrangler 状态，不代表已经连接远端开发数据。

### 配置检查

```bash
npm run check
```

`check` 会先执行 `scripts/assert-dev-config.mjs`，确认 Worker、D1、KV、环境变量和资源名均为 dev-only，然后执行 Wrangler dry-run。发现非 dev 资源、生产路由、Custom Domain、R2 binding 或缺少必要配置时会直接失败。

### 测试

```bash
npm test
```

当前测试覆盖：

- 认证、管理员 OTP 初始化、普通用户密码登录和 JWT 身份检查
- 多存储路径隔离和 D1 作用域
- 文件/目录权限、分享创建、分享下载和分享失效
- S3 SigV4、Range、XML、流式上传下载和凭证加密
- D1 迁移、存储生命周期、同步分页和失败恢复
- TXT 编码识别、正文索引、阅读进度和书签
- ZIP 文件数量限制和任务行为

### 部署到开发环境

```bash
npm run deploy:dev
```

部署脚本固定执行：

1. 初始化缺失的 `.dev.vars`
2. 检查 dev-only 配置
3. 使用 `wrangler.dev.jsonc` 和 `.dev.vars` 部署 `edgestash-dev`
4. 写入被忽略的 `.dev-deployment.json`

部署成功后再运行：

```bash
npm run verify:dev
```

`verify:dev` 会重新检查配置，读取 `edgestash-dev` 最新版本，并确认部署 URL 的 `/login.html` 正常返回。

仓库提供 `deploy` 作为通用自托管部署入口；`deploy:dev` 只用于本项目作者维护的隔离开发环境。

## Dashboard 一键部署

当前版本可以使用 Cloudflare 官方的 **Deploy to Cloudflare** 按钮，不需要用户手动安装 Wrangler CLI。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/BigCat-byebye/EdgeStashPro)

### 这个按钮会做什么

Cloudflare 会：

1. 克隆公开 GitHub/GitLab 仓库到用户自己的账号。
2. 打开一次配置页面，让用户选择仓库名、Worker 名称和资源名称。
3. 根据 `wrangler.jsonc` 自动创建并绑定 D1、KV 等支持的 Cloudflare 资源。
4. 根据 `.env.example` 和 `package.json` 中的绑定说明收集必要的 Secret。
5. 使用仓库中的 `deploy` 脚本构建并部署 Worker。

官方文档：

```txt
https://developers.cloudflare.com/workers/platform/deploy-buttons/
```

### 普通用户操作步骤

1. 点击上面的 **Deploy to Cloudflare** 按钮。
2. 登录自己的 Cloudflare 和 GitHub/GitLab 账号。
3. 在 Cloudflare 配置页确认 Worker 名称、D1 名称、KV 名称。
4. 为以下两个 Secret 填写自己的值：
   - `ADMIN_PASSWORD`：管理员密码。
   - `STORAGE_CONFIG_KEY`：base64 编码的 32 字节随机密钥。
5. 点击 Deploy，等待 Cloudflare 创建资源并完成部署。
6. 打开部署后的 `/login.html`，使用管理员密码绑定 OTP。
7. 进入管理后台的“存储”页面，配置自己的 S3/R2/OSS/COS/MinIO 连接。

仓库中的 `.env.example` 只包含变量名和空值，不包含作者的任何 Secret。每个用户都应填写自己的密码、加密密钥和存储凭证。
### 配置页中的 Build / Deploy command

- **Build command：留空。** 当前项目没有前端构建步骤，页面模板由 Worker 在部署时直接打包。
- **Deploy command：填写 `npm run deploy`。** `package.json` 已提供该脚本，实际执行 `wrangler deploy --config wrangler.jsonc`。如果 Cloudflare 自动填入 `npx wrangler deploy`，也可以使用，因为它会读取根目录的通用 `wrangler.jsonc`。

### `STORAGE_CONFIG_KEY` 是否需要记住？

它不是登录密码，也不是每天需要输入的验证码；它是存储凭证的**长期加密主密钥**。每次保存 S3 凭证时，系统使用它加密后写入 D1，之后读取凭证时仍必须使用同一个 key 解密。

因此：

- 第一次部署时生成并填写一次即可。
- 后续重新部署必须继续使用同一个值，不能每次随机生成新值。
- 不需要每天记住，建议保存在密码管理器或 Cloudflare Secret 中。
- 如果丢失，旧的 S3 凭证无法解密，需要在管理后台重新输入各存储凭证。
- 它不能安全地由 Worker 每次启动自动随机生成；那样会导致重启或重新部署后旧凭证全部失效。

可以使用密码管理器生成 32 字节随机值，或者本地执行：

```bash
openssl rand -base64 32
```


### 当前边界

- 这个按钮适用于公开 GitHub/GitLab 的 Workers 应用，不适用于 Pages 应用。
- 它不支持把多模块项目粘贴到 Dashboard 在线编辑器；不要只复制 `src/index.js`。
- D1 和 KV 可以由 Cloudflare 根据 Wrangler 配置自动创建。
- 本项目不声明 R2 binding；R2 通过 S3 API 动态连接，因此部署完成后仍需在管理后台填写 R2 的 S3 Endpoint、Bucket 和凭证。
- Cloudflare R2 的 S3 API 凭证不会由按钮自动生成，不能把 R2 Access Key 写入仓库或 README。
- 如果仓库设置为私有，Deploy to Cloudflare 按钮无法供其他用户使用。

### 命令行部署仍然可用

工程师可以继续使用：

```bash
npm ci
npm run deploy
```

开发者维护本项目隔离环境时使用：

```bash
npm run provision:dev
npm run deploy:dev
npm run verify:dev
```

当前 `wrangler.jsonc` 是面向 Deploy to Cloudflare 的通用配置；作者自己的开发配置由 `provision:dev` 生成到被忽略的 `wrangler.dev.jsonc`，不会与开源一键部署混用。

## 开源前安全检查

当前仓库的开发 Secret 文件由 `.gitignore` 排除：

```txt
.dev.vars*
.env* (except .env.example)
.dev-deployment.json
wrangler.dev.jsonc
.wrangler/
dist/
```
测试文件中的密码、Access Key 和 Secret Key 只是内存回归 fixture，不是线上凭证。README 不包含 Demo 登录密码。

发布前仍需确认：

- 不要提交 `.dev.vars`、`.env`、Cloudflare API Token、S3 凭证或 OTP Secret。
- 不要提交 `wrangler.dev.jsonc`；它由 `provision-dev` 生成并包含当前账号的开发资源 ID。公开部署只使用通用的 `wrangler.jsonc`。
- 为真实用户部署前，应把普通用户密码从无盐 SHA-256 升级为带随机盐的慢哈希，并增加登录限流/失败锁定。
- 管理员密码必须是随机长密码，OTP 必须由每个部署者重新绑定。

## 动态存储配置

部署 Worker 后，管理员进入：

```txt
管理后台 -> 存储
```

添加 S3 兼容连接，需要填写：

- 名称
- S3 Endpoint
- Region
- Bucket
- Path style 或 Virtual host style
- Access Key ID
- Secret Access Key
- 可选 Session Token
- 自动同步间隔

保存前会通过 ListObjectsV2 测试连接。连接保存后可以：

- 设为默认存储
- 手动同步
- 停用/启用
- 编辑名称、计划和凭证
- 删除连接

首页右上角和管理后台使用同一个存储选择器。切换存储时，目录回到根目录，当前缓存、选中项、标签状态和视图数据都会按新存储重新加载。

### 同步模型

- 目录浏览、搜索、收藏、最近访问和权限资源搜索只读 D1，不自动 List/Head 远端。
- 页面“刷新”会创建当前目录前缀的同步作业，接口立即返回，前端显示排队/同步/完成/失败状态。
- Cron 每分钟检查到期存储并继续可恢复的扫描作业。
- 扫描使用 continuation token、scan ID 和 lease，失败时保留旧目录，不执行危险的 stale sweep。
- 最终清理只作用于当前 `storage_id` 和当前前缀。

## D1 迁移和旧数据

D1 迁移由 `src/db/schema.js` 在运行时执行，使用 `schema_migrations` 表，不需要手工运行仓库中的 SQL 文件。

当前关键迁移：

```txt
007_multi_storage
008_folder_object_rows
```

多存储迁移会：

- 将旧表改造成带 `storage_id` 的存储作用域模型
- 把旧数据迁移到 `legacy-default`
- 保留旧路径、分享、收藏、最近访问、阅读进度、书签、权限和任务关系
- 创建一个等待配置的旧默认存储占位连接

没有旧存储的 S3 凭证时，不能声称旧对象已经完成迁移。连接占位会保持 `setup_required`，不会猜测 Endpoint、清空 D1 或恢复旧 R2 binding。

首版不支持跨存储复制或移动；复制/移动的源和目标必须属于同一个存储。

## 登录和 OTP

打开：

```txt
https://edgestash-dev.crazytwo1794872727.workers.dev/login.html
```

管理员登录使用：

1. `ADMIN_PASSWORD`
2. 管理员 OTP
3. 两者都正确后签发管理员 JWT

首次没有 OTP 配置时，登录页会显示二维码和 Secret。使用 Google Authenticator、Microsoft Authenticator 或 1Password 扫码后输入 6 位验证码。

普通用户由管理员在“管理后台 -> 授权用户”创建，使用邮箱和密码登录，不需要 OTP。

当前版本没有开发环境登录绕过；错误密码不会创建会话，只有完成正常认证才会返回 JWT。

### 旋转开发管理员密码

`.dev.vars` 是被 `.gitignore` 忽略的本地开发 Secret 文件。修改其中的 `ADMIN_PASSWORD` 后重新部署：

```bash
npm run deploy:dev
```

### 重置开发 OTP

下面的命令明确使用 `wrangler.jsonc` 中的 `KV_STORE` 绑定和远端开发 KV：

```bash
npx wrangler kv key delete --config wrangler.jsonc --remote --binding KV_STORE admin:otp:secret
npx wrangler kv key delete --config wrangler.jsonc --remote --binding KV_STORE admin:otp:pending
```

删除后重新打开 `/login.html`，输入管理员密码即可重新生成二维码。不要删除生产 KV，也不要把 Secret 写进 README、源码或命令历史。

## 用户权限

普通用户不是全盘默认可见，只能看到管理员授权范围内的资源。

| 权限 | 作用 |
| --- | --- |
| 查看 | 在目录和搜索结果中看到资源 |
| 预览 | 在线打开支持的文件 |
| 下载 | 下载文件或批量下载 |
| 上传 | 向目录上传文件或创建文件夹 |
| 修改 | 重命名、移动等修改操作 |
| 删除 | 删除文件或目录 |
| 分享 | 创建公开分享链接 |

授权支持文件或目录、多选资源、权限模板和自定义权限。目录授权会作用于子目录；普通用户不会看到未授权资源。

## 分享链接

首页选中一个或多个文件/目录后，在批量操作栏点击“分享”。分享支持：

- 只读目录浏览
- 多个文件/目录共用一个分享链接
- 可选密码
- 过期时间
- 浏览和下载统计
- 分享二维码

相关接口：

| 接口 | 作用 |
| --- | --- |
| `POST /api/share` | 创建分享，支持 `items`，兼容旧 `filePath` |
| `GET /api/share/:id` | 查询分享状态 |
| `POST /api/share/:id/list` | 浏览分享目录 |
| `POST /api/share/:id/download` | 下载分享范围内的文件 |

分享页地址格式：

```txt
/s/<shareId>
```

## 运行时页面和 API

| 路径 | 作用 |
| --- | --- |
| `/login.html` | 管理员/普通用户登录 |
| `/` | 云盘首页 |
| `/admin.html` | 管理后台 |
| `/s/<shareId>` | 公开分享页 |
| `/api/auth/check` | 检查当前 JWT 会话 |
| `/api/storages` | 当前用户可访问的存储列表 |
| `/api/admin/storages` | 管理员存储连接管理 |
| `/api/admin/users` | 管理员授权用户管理 |
| `/api/admin/shares` | 管理员分享链接管理 |

## 常见问题

### 为什么看不到存储或目录？

先确认管理员已经在后台配置至少一个启用的 S3 存储，并完成连接测试。普通用户还必须在当前存储上获得权限。

### 为什么日常浏览不会立即请求 S3？

D1 是目录和搜索的热路径。只有首次建索引、手工刷新、同步作业、上传、删除、移动、重命名、预览和下载等操作才访问 S3。

### 什么时候需要点击“刷新”？

如果文件是通过其他 S3 客户端或云厂商控制台直接修改的，点击刷新让 D1 与远端重新对账。正常通过网页上传、删除、移动和重命名会立即更新 D1，不需要每次刷新。

### OTP 忘记了怎么办？

删除当前开发环境 KV 中的 `admin:otp:secret` 和 `admin:otp:pending`，然后重新用管理员密码登录并扫码。生产环境请只通过拥有权限的 Cloudflare 管理员操作。

### 普通用户为什么看不到根目录全部文件？

这是权限模型设计。管理员需要在当前存储上授予 `/` 或具体目录的“查看”权限，普通用户才会看到对应资源。

## 参考

- Cloudflare Workers Wrangler：https://developers.cloudflare.com/workers/wrangler/
- Wrangler Workers deploy：https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
