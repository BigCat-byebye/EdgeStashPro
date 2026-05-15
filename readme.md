# EdgeStash Worker

一个单文件 Cloudflare Worker 网盘界面，代码在 `worker.j`。它使用 Cloudflare R2 存文件，使用 KV 保存登录用户、分享信息、统计信息和目录列表缓存。

## 声明
本项目基于 https://github.com/hhy-2021/EdgeStash 优化, 增加了一些缓存和中文路径等支持

## 功能

- 管理员登录
- 普通用户登录和授权管理
- 文件上传、下载、删除、重命名
- 文件夹创建、删除、重命名
- 目录浏览
- 图片、PDF、文本、Markdown、音视频、docx 预览
- 文件分享链接，可选密码和过期时间
- 管理后台查看分享、用户和统计信息
- 中文文件名和中文目录路径支持
- TXT 预览支持 UTF-8、UTF-16 和 GB18030/GBK 常见中文编码
- PDF 预览支持 Range 请求，适配浏览器内置 PDF 预览器
- 目录列表缓存到 KV，减少频繁读取 R2

## 文件结构

当前项目只需要这个 Worker 文件：

```txt
worker.j
```

`README.md` 只是部署和说明文档，不参与运行。

## Cloudflare 绑定

Worker 需要绑定两个资源，绑定名必须和代码一致：

| Binding 名 | 类型 | 用途 |
| --- | --- | --- |
| `R2_BUCKET` | R2 Bucket | 存储上传的文件 |
| `KV_STORE` | KV Namespace | 存储用户、分享、统计和目录缓存 |

不需要 D1。

## 环境变量

需要设置：

| 变量名 | 说明 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员登录密码，也是 JWT 签名密钥 |

## 部署方式

### 1. 创建 R2 Bucket

在 Cloudflare Dashboard 创建一个 R2 Bucket，例如：

```txt
edgestash-files
```

### 2. 创建 KV Namespace

创建一个 KV Namespace，例如：

```txt
edgestash-kv
```

### 3. 创建 Worker

在 Cloudflare Workers 中创建 Worker，把 `worker.j` 的内容粘贴进去。

如果 Cloudflare 要求文件扩展名是 `.js`，可以把内容复制到 Worker 编辑器里，或者本地部署时把文件名作为入口配置为 `worker.j`。

### 4. 添加绑定

在 Worker 设置里添加：

```txt
R2_BUCKET -> 你的 R2 Bucket
KV_STORE  -> 你的 KV Namespace
```

注意：左边是代码里的 Binding 名，必须一字不差。

### 5. 添加环境变量

添加：

```txt
ADMIN_PASSWORD=你的管理员密码
```

### 6. 部署

保存并部署 Worker。访问 Worker 域名后会跳转到登录页：

```txt
https://你的-worker.workers.dev/
```

管理员登录时只需要输入 `ADMIN_PASSWORD`。

## 使用说明

### 管理员登录

访问 `/login.html`，选择“管理员登录”，输入 `ADMIN_PASSWORD`。

管理员可以：

- 进入网盘界面
- 进入管理后台
- 添加普通用户
- 删除普通用户
- 查看分享链接
- 删除分享链接
- 查看统计信息

### 普通用户登录

管理员在后台添加用户后，普通用户可以用邮箱和密码登录。

普通用户可以使用网盘功能，但不能进入管理后台。

### 上传和目录

文件实际存储在 R2 中。目录是通过 R2 key 前缀模拟的。

新建文件夹时，Worker 会在 R2 中写入一个空对象：

```txt
目录名/.folder
```

这个 `.folder` 对象不会在文件列表中显示。

## KV 数据说明

KV 会保存几类数据。

### 用户

```txt
user:邮箱
```

内容是用户信息和密码哈希。

### 分享

```txt
share:分享ID
```

内容是分享文件、过期时间、密码哈希、浏览次数和下载次数。

### 统计

```txt
stats:totalShares
stats:totalViews
stats:totalDownloads
```

### 目录缓存

```txt
cache:dir:/
cache:dir:/资料
cache:dir:/资料/子目录
```

每个 key 存一个目录下的文件和文件夹列表。

缓存内容大致是：

```json
{
  "success": true,
  "files": [],
  "folders": [],
  "currentPath": "/资料",
  "refreshedAt": 1730000000000
}
```

## 目录缓存机制

目录列表接口会优先读 KV：

1. 用户打开目录。
2. Worker 查询 `cache:dir:<当前目录>`。
3. 如果 KV 有缓存，直接返回缓存。
4. 如果 KV 没缓存，Worker 从 R2 `list` 获取目录内容。
5. Worker 把目录内容写入 KV。
6. 返回列表给前端。

右上角“刷新”按钮会强制跳过旧缓存：

1. 重新读取当前目录的 R2 内容。
2. 覆盖当前目录的 KV 缓存。
3. 前端重新渲染当前目录。

文件变更后会让相关缓存失效：

- 上传文件：删除当前目录缓存
- 新建文件夹：删除父目录缓存
- 删除文件：删除父目录缓存
- 删除文件夹：删除父目录缓存，并删除该文件夹及其子目录缓存
- 重命名：删除旧路径和新路径相关缓存

下次打开目录时会重新从 R2 构建缓存。

## 中文文件名支持

浏览器会把中文路径编码成 `%E4%B8%AD...`，Worker 会在路由中解码，再用原始中文 R2 key 读取文件。

前端请求文件接口时，会按路径段进行编码，避免中文、空格、`#`、`?` 等字符破坏 URL。

下载响应使用：

```txt
Content-Disposition: attachment; filename*=UTF-8''...
```

预览响应使用：

```txt
Content-Disposition: inline; filename*=UTF-8''...
```

这样中文文件名在下载和预览中都能正常处理。

## 预览说明

### 图片

图片文件通过 `<img>` 预览。

支持扩展名：

```txt
jpg jpeg png gif webp svg ico bmp
```

### PDF

PDF 使用 `<iframe>` 调用浏览器内置 PDF 预览器。

Worker 的 `/api/preview` 支持 `Range` 请求，并返回：

```txt
Accept-Ranges: bytes
Content-Range: bytes ...
```

这对 Chrome、Edge 等浏览器的 PDF 预览比较重要。

### 文本

文本预览会读取 ArrayBuffer 后尝试解码：

1. UTF-8 BOM
2. UTF-16 LE
3. UTF-16 BE
4. 严格 UTF-8
5. GB18030/GBK
6. UTF-8 兜底

所以常见中文 TXT 不容易乱码。

### Markdown

Markdown 使用 `marked` 渲染。

注意：Markdown 内容会渲染为 HTML。如果这个网盘开放给不可信用户上传 Markdown，建议后续增加 HTML sanitize。

### docx

docx 使用 `mammoth.js` 转 HTML 预览。

同样建议对不可信用户上传的 docx 预览内容做 HTML sanitize。

## API 简表

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/login` | POST | 登录 |
| `/api/logout` | POST | 退出 |
| `/api/auth/check` | GET | 检查登录状态 |
| `/api/files/<path>` | GET | 获取目录列表 |
| `/api/files/<path>` | POST | 上传文件 |
| `/api/files/<path>` | PUT | 重命名 |
| `/api/files/<path>` | DELETE | 删除文件或目录 |
| `/api/folders` | POST | 新建文件夹 |
| `/api/download/<path>` | GET | 下载文件 |
| `/api/preview/<path>` | GET | 预览文件 |
| `/api/cache/refresh` | POST | 刷新当前目录 KV 缓存 |
| `/api/share` | POST | 创建分享 |
| `/api/share/<id>` | GET | 获取分享信息 |
| `/api/share/<id>/download` | POST | 分享下载 |
| `/api/admin/stats` | GET | 管理后台统计 |
| `/api/admin/shares` | GET | 分享列表 |
| `/api/admin/users` | GET | 用户列表 |
| `/api/admin/users` | POST | 添加用户 |

## 常见问题

### 没有绑定 KV 会怎样？

登录、用户、分享、统计和目录缓存都依赖 `KV_STORE`。没有 KV 绑定时，Worker 会报错。

### 没有绑定 R2 会怎样？

文件列表、上传、下载和预览都依赖 `R2_BUCKET`。没有 R2 绑定时，Worker 会报错。

### 还需要绑定 D1 吗？

不需要。当前版本已经移除 D1 缓存逻辑，目录缓存直接写入 `KV_STORE`。

### 目录缓存错了怎么办？

在网页右上角点击“刷新”，会重新从 R2 获取当前目录并覆盖 KV 缓存。

也可以手动删除 KV 中对应 key：

```txt
cache:dir:/你的目录
```

### 中文文件能上传但打不开怎么办？

先点击右上角“刷新”更新当前目录缓存。如果仍然失败，检查文件名里是否包含特殊字符。当前前端会按路径段编码，正常中文、空格、`#`、`?` 都应该可以处理。

### PDF 预览打不开怎么办？

优先检查：

- 文件扩展名是否是 `.pdf`
- R2 中文件是否完整
- 浏览器是否支持内置 PDF 预览
- 当前目录是否刷新过缓存

如果下载正常但预览不正常，通常和浏览器 PDF 预览器或 Range 请求有关。

## 安全提示

- `ADMIN_PASSWORD` 同时用于管理员登录和 JWT 签名，建议设置强密码。
- 当前登录 Cookie 是 `HttpOnly` 和 `SameSite=Strict`。
- Markdown/docx 预览存在 HTML 注入风险，开放给不可信用户时建议后续增加 sanitize。
- 分享链接如果设置为永久有效，需要手动在管理后台删除。

## 维护建议

- 定期清理无效分享链接。
- 如果大量重命名或批量移动文件，建议刷新相关目录缓存。
- KV 是最终一致性，刚写入后在极少数情况下可能有短暂延迟。
- 大目录首次加载仍然会访问 R2，之后才会命中 KV 缓存。
