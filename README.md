# 霜华 Image 2 

一个基于 Express 的 GPT Image 2 图像生成与编辑网页应用。后端作为 API 代理，前端为原生 HTML/CSS/JavaScript，无打包构建流程。

## 功能特性

- 文本生成图片。
- 上传 PNG、JPEG、WebP 图片进行图生图编辑。
- 支持基于已生成图片继续编辑。
- 支持 Responses API 流式生成，生成过程中可显示预览图。
- 支持 Image API 兼容模式。
- 支持质量、尺寸和流式模型选择。
- 后台异步任务轮询，页面刷新后可恢复短期未完成任务。
- API URL 和 API Key 仅保存在浏览器 `localStorage` 中。

## 技术栈

- Node.js
- Express
- Multer
- node-fetch v2
- 原生前端：`public/index.html`、`public/style.css`、`public/app.js`

## 安装与启动

安装依赖：

```bash
npm install
```

启动服务：

```bash
npm start
```

也可以使用：

```bash
npm run dev
```

默认监听地址：

```text
http://localhost:3002
```

如需修改端口：

```bash
PORT=3000 npm start
```

Windows PowerShell 示例：

```powershell
$env:PORT=3000; npm start
```

## 使用方式

1. 打开 `http://localhost:3002`。
2. 点击设置按钮。
3. 填写 API URL，例如 `https://api.openai.com/v1` 或兼容服务的 `/v1` 地址。
4. 填写 API Key。
5. 选择图片质量、尺寸、生成模式和流式模型。
6. 输入提示词后发送。
7. 如需编辑图片，可上传图片，或在生成结果中点击编辑后继续输入编辑提示词。

## 生成模式

### Responses API

默认模式。后端请求 `${API_URL}/responses`，使用 `image_generation` 工具并开启流式响应。

可选流式模型：

- `gpt-5.4-mini`
- `gpt-5.4`
- `gpt-5.5`

### Image API

兼容模式。文本生成请求 `${API_URL}/images/generations`，图片编辑请求 `${API_URL}/images/edits`，模型固定为 `gpt-image-2`。

## 本地存储

前端会在浏览器 `localStorage` 中保存以下配置：

- `gptimg_config`：API URL 和 API Key。
- `gptimg_quality`：图片质量。
- `gptimg_size`：图片尺寸。
- `gptimg_stream_mode`：生成模式。
- `gptimg_model`：流式模型。
- `gptimg_pending_tasks`：短期未完成任务，用于刷新后恢复轮询。

项目不会从 `.env` 文件读取 API Key。

## 后端接口

### `GET /api/health`

健康检查。

响应示例：

```json
{ "ok": true }
```

### `POST /api/generate`

创建文本生成图片任务。

请求体为 JSON，主要字段：

- `prompt`：提示词，必填。
- `config.url`：上游 API Base URL，必填。
- `config.key`：API Key，必填。
- `quality`：`auto`、`low`、`medium`、`high`。
- `size`：`auto`、`1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`。
- `stream`：是否使用 Responses API 流式模式。
- `model`：流式模式使用的模型。

响应状态码为 `202`，返回任务 ID：

```json
{ "taskId": "...", "status": "running" }
```

### `POST /api/edit`

创建图片编辑任务。

请求类型为 `multipart/form-data`，主要字段：

- `images`：待编辑或参考图片，可多张，必填。
- `mask`：蒙版，仅 Image API 模式可用。
- `prompt`：编辑提示词，必填。
- `config`：JSON 字符串，包含 `url` 和 `key`。
- `quality`、`size`、`stream`、`model`：同生成接口。

响应状态码为 `202`，返回任务 ID。

### `GET /api/tasks/:id`

查询异步任务状态。

任务状态包括：

- `pending`
- `running`
- `completed`
- `failed`

完成后可从 `result.data[0].b64_json` 或 `result.data[0].url` 获取图片数据。

## 限制与安全策略

- 仅支持上传 `image/png`、`image/jpeg`、`image/webp`。
- 单张上传图片最大 20 MB。
- 单次最多上传 10 张图片，另可包含 1 张 mask。
- 单次上传总大小最大 200 MB。
- 提示词长度限制为 1-20000 字符。
- 上游请求超时时间为 5 分钟。
- 任务只保存在内存中，服务重启后会丢失。
- 完成或失败的任务会在短时间后过期清理。
- 默认禁止 API URL 指向 localhost、内网或保留地址，避免 SSRF 风险。

如果确实需要连接本机或内网兼容 API，可启动时设置：

```bash
ALLOW_PRIVATE_API_URLS=1 npm start
```

Windows PowerShell 示例：

```powershell
$env:ALLOW_PRIVATE_API_URLS=1; npm start
```

## 项目结构

```text
.
├── server.js          # Express 静态服务与 API 代理
├── package.json       # 依赖与启动脚本
├── API.md             # 上游 API 参考资料
├── public/
│   ├── index.html     # 页面结构
│   ├── style.css      # 页面样式
│   ├── app.js         # 前端交互逻辑
│   └── logo.png       # 页面图标
└── 风格规范.md        # 视觉风格规范
```

## 开发说明

- 当前没有构建步骤、测试脚本、Lint 或 CI 配置。
- `npm start` 和 `npm run dev` 都等价于 `node server.js`。
- 前端改动保存后刷新浏览器即可查看。
- 后端改动需要重启 Node 进程。
