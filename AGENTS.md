# GPT Image 2 Web 项目说明

## 项目定位

- 本项目是一个单用户本地使用的 GPT Image 2 图像生成与编辑网页应用。
- 后端是 `server.js` 中的 Express 代理服务，负责静态文件托管、API URL 安全校验、上传校验、上游请求转发和异步任务缓存。
- 前端是 `public/` 下的原生 HTML/CSS/JavaScript 页面，不使用框架、构建工具、客户端路由或打包流程。
- 应用支持文本生图、上传图片编辑、基于已生成结果继续编辑、Responses API 流式预览和 Image API 兼容模式。
- `API.md` 是上游 GPT Image / Responses API 的参考资料；当文档与当前代码不一致时，以 `server.js` 和 `public/app.js` 的实际实现为准。

## 技术栈

- Node.js + CommonJS。
- Express 4，负责 HTTP 服务和静态资源托管。
- Multer，使用内存存储处理图片上传。
- node-fetch v2，通过 `require('node-fetch')` 引入，不要改成 ESM 导入，除非整体迁移模块系统。
- form-data，用于向上游 Image API 转发 multipart 请求。
- 原生前端文件：`public/index.html`、`public/style.css`、`public/app.js`。

## 项目结构

```text
.
├── server.js          # Express 静态服务、API 代理、异步任务、上传与安全校验
├── package.json       # 依赖与启动脚本
├── package-lock.json  # 锁定依赖版本
├── README.md          # 面向用户的基础说明
├── API.md             # 上游 GPT Image / Responses API 参考资料
├── AGENTS.md          # 本文件，面向后续开发协作的完整项目说明
├── 风格规范.md        # DeepSeek Chat 风格规范来源
└── public/
    ├── index.html     # 页面结构与设置面板
    ├── style.css      # DeepSeek 风格样式与响应式布局
    ├── app.js         # 前端状态、上传、任务轮询、编辑流程
    └── logo.png       # 页面图标
```

## 运行命令

- 安装依赖：`npm install`。
- 启动服务：`npm start`。
- 开发启动：`npm run dev`。
- `npm start` 和 `npm run dev` 都等价于 `node server.js`，没有 watch mode。
- 默认端口是 `process.env.PORT || 3002`，启动后访问 `http://localhost:<PORT>`。
- Windows PowerShell 修改端口示例：`$env:PORT=3000; npm start`。
- 当前没有 build、lint、format、typecheck、test 或 CI 配置。
- 前端改动保存后刷新浏览器即可查看；后端改动需要重启 Node 进程。

## 手动验证流程

- 启动服务并打开 `http://localhost:3002`。
- 在设置面板填写 API URL，例如 `https://api.openai.com/v1` 或兼容服务的 `/v1` 地址。
- 填写 API Key，选择图片质量、尺寸、生成模式和流式模型。
- 文本提示词走生图流程；上传图片或进入编辑模式后走图生图编辑流程。
- 检查生成、编辑、下载、大图预览、删除、清空时间线、刷新后恢复轮询等基础交互。
- Responses API 模式可观察流式预览；Image API 兼容模式不会显示 Responses 流式预览。

## 后端接口

- `GET /api/health`：健康检查，返回 `{ ok: true }`。
- `GET /api/tasks/:id`：查询异步任务状态，任务不存在或过期时返回 404。
- `POST /api/generate`：创建文本生成任务，返回 `202 { taskId, status }`。
- `POST /api/edit`：创建图片编辑任务，返回 `202 { taskId, status }`。
- 未匹配的 `/api/*` 路由返回 JSON 404，错误信息为中文。

## 异步任务模型

- `/api/generate` 和 `/api/edit` 不直接等待上游完成，而是创建内存任务并立即返回 task id。
- 前端轮询 `GET /api/tasks/:id` 获取 `pending`、`running`、`completed` 或 `failed` 状态。
- 任务对象包含 `id`、`type`、`status`、`createdAt`、`updatedAt`、`result`、`partials` 和 `error`。
- Responses 流式模式收到局部图片时，会将最近最多 3 张 partial image 写入任务的 `partials`。
- 完成或失败任务在内存中保留 10 分钟。
- 运行中任务保留时间为上游 5 分钟超时加 10 分钟结果窗口。
- 总任务缓存上限为 100，运行中或等待中的任务上限为 20。
- 任务只存在进程内存中，服务重启后全部丢失；没有数据库、队列、session、SSE 到浏览器或 durable storage。

## 上游 API 路径选择

- 浏览器只提交 API base URL 和 API key，后端会去除末尾斜杠后拼接上游路径。
- Responses API 模式请求 `${API_URL}/responses`。
- Image API 兼容模式的文本生成请求 `${API_URL}/images/generations`。
- Image API 兼容模式的图片编辑请求 `${API_URL}/images/edits`。
- 流式模式只通过本地异步任务和轮询暴露给浏览器，不要把上游 SSE 连接直接绑定到浏览器连接。

## `POST /api/generate`

- 请求体是 JSON，Express JSON 限制为 2 MB。
- 必填字段：`prompt`、`config.url`、`config.key`。
- 可选字段：`quality`、`size`、`stream`、`model`、`n`、`format`。
- `prompt` 必须是 1 到 20000 字符。
- `stream !== false` 时使用 Responses API。
- Responses API 模式使用 `image_generation` tool，`action: "generate"`，`partial_images: 3`，并开启 `stream: true`。
- Responses API 模式允许的模型是 `gpt-5.4-mini`、`gpt-5.4`、`gpt-5.5`，默认 `gpt-5.4-mini`。
- `stream === false` 时使用 Image API 兼容模式，模型固定为 `gpt-image-2`。
- Image API 兼容模式会转发非默认的 `quality`、`size`、`output_format`，并在 `n > 1` 时转发 `n`。

## `POST /api/edit`

- 请求类型是 `multipart/form-data`。
- 必填字段：`images`、`prompt`、`config`。
- 可选字段：`quality`、`size`、`stream`、`model`、`format`、`mask`。
- `config` 在 multipart 中是 JSON 字符串，包含 `url` 和 `key`。
- 至少需要 1 张 `images` 图片。
- 最多 10 张 `images`，另可附带 1 张 `mask`。
- 仅支持 PNG、JPEG、WebP，后端会按文件内容魔数重新识别 MIME。
- 单文件上限 20 MB，单次上传总量上限 200 MB，同时解析上传的请求上限为 3。
- `stream !== 'false'` 时使用 Responses API，发送 `input_text` 加多个 `input_image.image_url` data URL，tool 使用 `action: "edit"`。
- Responses API 编辑不使用上游 `/files` 存储，每次编辑都重新发送来源图和参考图。
- Responses API 编辑暂不支持 `mask`；带 mask 时必须切换到 Image API 兼容模式，否则后端返回错误。
- Image API 兼容模式模型固定为 `gpt-image-2`，上传字段转发为 `image[]`，可选 mask 转发为 `mask`。
- mask 的 alpha channel、尺寸匹配等细节主要交给上游校验；本地只做基础图片格式校验。

## 上游 GPT Image 行为要点

- Image API 适合单次文本生图、单次图片编辑、参考图生成和 mask 编辑。
- Responses API 适合对话式、多步骤或需要流式 partial images 的图像体验。
- 本项目没有使用 `previous_response_id` 或历史 `image_generation_call` id；时间线中的每次生成和编辑都是新的上游请求。
- Responses API 的 `image_generation` tool 可通过 `action` 控制生成或编辑，本项目生图强制 `generate`，图生图强制 `edit`。
- `gpt-image-2` 不支持透明背景；不要给该模型添加 `background: "transparent"` 控件。
- `gpt-image-2` 的图片输入默认高保真，当前项目不传 `input_fidelity`。
- 上游可能自动改写 prompt，Responses API 结果中可能包含 `revised_prompt`，当前 UI 没有展示该字段。
- 复杂图像请求可能需要较长时间；本地上游请求超时时间是 5 分钟。

## 图片参数

- 前端当前暴露质量：`auto`、`low`、`medium`、`high`。
- 前端当前暴露尺寸：`auto`、`1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`。
- `gpt-image-2` 支持更多符合约束的分辨率，但当前 UI 只提供上述选项。
- `gpt-image-2` 常见尺寸约束：最长边不超过 3840px，边长为 16px 倍数，长短边比例不超过 3:1，总像素在 655360 到 8294400 之间。
- 2K 以上输出在上游文档中属于实验性范围，可能成本和延迟更高。
- `format`、`n`、`mask` 在后端已有部分支持，但当前 UI 没有暴露 `n`、`format` 和 mask 控件。
- 上游还支持 `background`、`moderation`、`output_compression` 等能力，当前项目未暴露。

## 安全与资源限制

- 默认禁止 API URL 指向 localhost、内网、链路本地地址、保留地址和 IPv4-mapped IPv6 私有地址，降低 SSRF 风险。
- API URL 必须是 HTTP/HTTPS base URL，不能包含用户名、密码、query 或 hash。
- DNS 解析失败会拒绝请求。
- 如果确实需要连接本机或内网兼容 API，可设置 `ALLOW_PRIVATE_API_URLS=1`。
- `ALLOW_PRIVATE_API_URLS=1` 只适合单用户本地自用；不要在 LAN 或公网暴露服务时启用。
- 重定向最多 3 次，仅允许同源重定向，拒绝 HTTPS 到 HTTP 降级。
- 上传、上游响应和任务结果都存储在进程内存中；公网部署需要增加鉴权、限流、更严格内存控制或磁盘/流式上传路径。
- 上游 JSON 响应上限 50 MB，上游错误体上限 64 KB。
- SSE 总响应上限 80 MB，SSE buffer 和单事件上限都是 50 MB。
- 服务设置了基础安全响应头：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options` 和 CSP。

## 前端状态与存储

- `public/app.js` 是一个 vanilla JS IIFE，不要引入框架或构建步骤，除非明确要求重构。
- API URL 和 API Key 只存储在浏览器 `localStorage` 的 `gptimg_config` 中，不从 `.env` 读取。
- 图片质量存储在 `gptimg_quality`。
- 图片尺寸存储在 `gptimg_size`。
- 生成模式存储在 `gptimg_stream_mode`，值为 `stream` 或 `classic`。
- 流式模型存储在 `gptimg_model`。
- 未完成任务存储在 `gptimg_pending_tasks`，用于刷新或短暂断线后恢复轮询。
- 前端未完成任务恢复窗口是 10 分钟；超过该时间会清理本地 pending task。
- 如果保存 pending task 时因 localStorage 空间不足失败，前端会尝试去掉 `sourceImages` 后再保存，并在必要时通过 `beforeunload` 提醒用户。

## 前端生成与编辑流程

- 文本提示词且没有上传图片、没有编辑来源时，调用 `/api/generate`。
- 任意上传图片或进入已生成图片的编辑模式后，调用 `/api/edit`。
- 已生成图片的编辑会把该图片 data URL 转成 `File` 后作为 multipart 字段 `images` 提交。
- 上传图片和编辑来源图片总数最多 10 张。
- 上传前端也会校验文件类型、单文件 20 MB、总大小 200 MB 和内容 MIME。
- 编辑提示词会经过 `buildNumberedEditPrompt()` 添加中文编号说明，让上游模型区分图 1、图 2、图 3 等输入图片。
- 任务卡片显示生成/编辑类型、提示词、来源图、处理中状态、流式预览、最终图片、错误信息和操作按钮。
- 最终图片支持编辑、下载、查看大图和删除。
- 清空时间线会清除页面任务卡、pending tasks、上传预览和编辑模式。
- UI 文案是中文；新增用户可见文案应保持中文。

## 响应式与交互

- 页面由左侧 sidebar 和右侧 main 组成，桌面端可折叠侧边栏，移动端通过遮罩打开侧边栏。
- `index.html` 直接加载 `style.css` 和 `app.js`，没有客户端路由。
- 发送按钮只有在提示词非空、API URL/key 已设置且当前不忙时才可用。
- `Enter` 发送，`Shift+Enter` 换行。
- 首次没有 API 配置时，前端会延迟打开设置弹窗。
- 图片 data URL 只接受 PNG、JPEG、WebP；HTTP/HTTPS 图片 URL 仅用于展示或下载兜底。

## 视觉风格

- `public/style.css` 遵循 `风格规范.md` 中的 DeepSeek Chat 风格：极简、轻盈、圆润、低干扰。
- 整体以白底留白承载内容，用高饱和蓝色作为品牌识别和主要交互反馈。
- 默认只使用白、黑、灰、蓝四类颜色，避免引入多余强调色。
- 不要使用大面积渐变、复杂装饰图形、厚重阴影或高密度卡片。
- 主要交互控件应围绕输入框组织，突出“输入提示词生成或编辑图像”的核心任务。

## CSS Token

- CSS custom properties 使用 `--ds-*` 命名空间。
- 关键颜色：品牌蓝 `#3964FE`，选中浅蓝底 `#EDF3FE`，选中描边蓝 `#B7C8FE`，焦点蓝 `#3B82F6`。
- 背景与文本：页面背景 `#FFFFFF`，侧边栏背景 `#F9FAFB`，主文字 `#0F1115`，次级文字 `#81858C`。
- 轻边框使用 `rgba(0, 0, 0, 0.1)`，遮罩使用 `rgba(0, 0, 0, 0.4)`。
- 字体族保持 `quote-cjk-patch, Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif`。
- 保持大圆角语言：面板 `24px`，胶囊 `120px`，功能按钮 `18px`，圆形按钮 `50%`。
- 输入面板阴影使用大而淡的多层 shadow，不要改成重投影。
- 选中态使用浅蓝底、蓝色文字、蓝色描边或淡投影。
- Focus 使用蓝色焦点环，圆角与组件一致。

## 布局与组件规范

- 桌面端侧边栏宽度约 `261px`，背景 `#F9FAFB`，内边距约 `6px 12px 10px`。
- 主内容左右内边距约 `32px`，底部给输入区预留空间。
- 欢迎标题桌面端约 `24px / 600`，移动端约 `20px / 500`。
- 输入正文使用 `16px / 24px`。
- 输入面板保持白底、`24px` 圆角、轻边框和柔和阴影。
- 功能按钮高度约 `34px`，圆角 `18px`，字号 `13px`，选中态使用品牌蓝体系。
- 图标按钮桌面端约 `34px`，移动顶部按钮约 `44px`，默认透明背景，hover 只给极浅灰背景。
- 移动端保持顶部操作栏、输入面板和工具栏心智模型，不要改成全宽扁平输入框。

## 开发约束

- 优先做最小正确改动，避免引入无必要的新依赖、新框架或构建系统。
- 保持 CommonJS，除非明确进行全项目 ESM 迁移。
- 不要把 API key 写入服务端 `.env` 或代码中；当前设计是用户在浏览器设置并保存在 localStorage。
- 不要把上游流式响应直接转成浏览器 SSE；当前架构是后端后台任务 + 前端轮询。
- 不要新增持久化任务、用户系统、外部队列或 session，除非明确要求。
- 新增 API 路由时保持中文错误信息和 JSON 响应风格。
- 新增用户可见 UI 文案保持中文。
- 前端继续使用原生 DOM API；如需大规模重构，先明确范围。
- 编辑图片相关逻辑要同时考虑来源图、上传参考图、编号提示词和刷新恢复。
- 修改上传、任务缓存或上游响应处理时，注意内存上限和单用户本地使用定位。

## 常见风险点

- `API.md` 包含大量上游示例和可选能力，不代表当前 UI 已暴露。
- `README.md` 是面向用户的简要说明，本文件应作为后续开发时的主要上下文。
- 任务和图片结果都在内存里，长时间运行或大图批量请求可能带来内存压力。
- 本地 pending task 的 10 分钟恢复窗口可能短于后端运行中任务保留窗口。
- Responses 模式编辑没有 mask；mask 只走 Image API 兼容模式。
- `gpt-image-2` 不支持透明背景，不要添加与该模型冲突的 UI 选项。
- 当前服务默认阻止 localhost 和内网 API URL，开发兼容本地网关时需要显式设置 `ALLOW_PRIVATE_API_URLS=1`。
