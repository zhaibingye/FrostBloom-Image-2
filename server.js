const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormDataNode = require('form-data');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3002;
const UPSTREAM_TIMEOUT = 300000;
const FINISHED_TASK_TTL = 10 * 60 * 1000;
const RUNNING_TASK_TTL = UPSTREAM_TIMEOUT + FINISHED_TASK_TTL;
const MAX_TASKS = 100;
const MAX_RUNNING_TASKS = 20;
const MAX_ACTIVE_UPLOADS = 3;
const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 20000;
const MAX_API_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MAX_REDIRECTS = 3;
const MAX_UPSTREAM_JSON_BYTES = 50 * 1024 * 1024;
const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;
const MAX_SSE_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 50 * 1024 * 1024;
const MAX_SSE_TOTAL_BYTES = 80 * 1024 * 1024;
const ALLOW_PRIVATE_API_URLS = process.env.ALLOW_PRIVATE_API_URLS === '1';
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const RESPONSE_MODELS = new Set(['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5']);
const DEFAULT_RESPONSE_MODEL = 'gpt-5.4-mini';
const tasks = new Map();
let activeUploads = 0;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_FILE_BYTES, files: 11 } });

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/tasks/:id', (req, res) => {
  cleanupTasks();
  const task = tasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(task);
});

function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  while (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPrivateIp(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const mappedIpv4 = extractMappedIpv4(normalized);
  const ipv4 = mappedIpv4 || (normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized);
  const family = net.isIP(ipv4);
  if (family === 4) {
    const parts = ipv4.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('ff');
  }
  return true;
}

function extractMappedIpv4(address) {
  if (!address.startsWith('::ffff:')) return '';
  const suffix = address.slice(7);
  if (net.isIP(suffix) === 4) return suffix;
  const groups = suffix.split(':');
  if (groups.length !== 2) return '';
  const nums = groups.map(group => parseInt(group, 16));
  if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 0xffff)) return '';
  return `${nums[0] >> 8}.${nums[0] & 0xff}.${nums[1] >> 8}.${nums[1] & 0xff}`;
}

async function assertSafeApiUrl(url) {
  let parsed;
  const normalizedUrl = normalizeBaseUrl(url);
  if (!normalizedUrl || normalizedUrl.length > MAX_API_URL_LENGTH) throw createHttpError('API URL 长度无效');
  try {
    parsed = new URL(normalizedUrl);
  } catch (err) {
    throw createHttpError('API URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createHttpError('API URL 仅支持 HTTP/HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw createHttpError('API URL 不能包含用户名、密码、查询参数或片段');
  }
  await resolveSafeHost(parsed.hostname);
  return normalizeBaseUrl(parsed.toString());
}

async function resolveSafeHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host) throw createHttpError('API URL 不能指向本机或内网地址');
  if (!ALLOW_PRIVATE_API_URLS && /^localhost$/i.test(host)) throw createHttpError('API URL 不能指向本机或内网地址');
  const literalFamily = net.isIP(host);
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw createHttpError('API URL 域名解析失败');
  if (!ALLOW_PRIVATE_API_URLS && addresses.some(item => isPrivateIp(item.address))) throw createHttpError('API URL 不能指向本机、内网或保留地址');
  return addresses;
}

async function createSafeAgent(apiUrl) {
  const parsed = new URL(apiUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw createHttpError('API URL 仅支持 HTTP/HTTPS');
  const addresses = await resolveSafeHost(parsed.hostname);
  const lookup = (hostname, options, callback) => {
    if (String(hostname).replace(/^\[|\]$/g, '').toLowerCase() !== parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()) {
      callback(createHttpError('连接主机与已校验主机不一致'));
      return;
    }
    if (options?.all) {
      callback(null, addresses);
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  };
  return parsed.protocol === 'http:' ? new http.Agent({ lookup }) : new https.Agent({ lookup });
}

function validateConfig(config) {
  return config && typeof config.url === 'string' && config.url.trim() && config.url.length <= MAX_API_URL_LENGTH &&
    typeof config.key === 'string' && config.key.trim() && config.key.length <= MAX_API_KEY_LENGTH;
}

function validatePrompt(prompt) {
  return typeof prompt === 'string' && prompt.trim() && prompt.length <= MAX_PROMPT_LENGTH;
}

function normalizeImageSize(size) {
  if (!size || size === 'auto') return 'auto';
  if (typeof size !== 'string' || size.length > 16) throw createHttpError('图片尺寸格式无效');

  const normalized = size.trim().toLowerCase().replace(/\s+/g, '').replace('×', 'x');
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(normalized);
  if (!match) throw createHttpError('图片尺寸格式无效，请使用 2048x1152 这样的格式');

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw createHttpError('图片宽高必须是正整数');
  if (width > 3840 || height > 3840) throw createHttpError('图片最长边不能超过 3840px');
  if (width % 16 !== 0 || height % 16 !== 0) throw createHttpError('图片宽高都必须是 16px 的倍数');
  if (Math.max(width, height) / Math.min(width, height) > 3) throw createHttpError('图片长短边比例不能超过 3:1');

  const pixels = width * height;
  if (pixels < 655360 || pixels > 8294400) throw createHttpError('图片总像素必须在 655,360 到 8,294,400 之间');
  return `${width}x${height}`;
}

function createTask(type) {
  cleanupTasks();
  const runningCount = Array.from(tasks.values()).filter(task => task.status === 'pending' || task.status === 'running').length;
  if (runningCount >= MAX_RUNNING_TASKS) {
    const error = new Error('当前任务较多，请稍后再试');
    error.status = 429;
    throw error;
  }
  if (tasks.size >= MAX_TASKS) {
    const error = new Error('任务缓存已满，请稍后再试');
    error.status = 429;
    throw error;
  }
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const task = { id, type, status: 'pending', createdAt: now, updatedAt: now, result: null, partials: [], error: null };
  tasks.set(id, task);
  return task;
}

function updateTask(task, patch) {
  Object.assign(task, patch, { updatedAt: Date.now() });
}

function runTask(task, work) {
  updateTask(task, { status: 'running' });
  Promise.resolve()
    .then(work)
    .then(result => updateTask(task, { status: 'completed', result, error: null }))
    .catch(err => updateTask(task, { status: 'failed', result: null, error: err.name === 'AbortError' ? '请求超时' : err.message }));
}

function cleanupTasks() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    const ttl = task.status === 'completed' || task.status === 'failed' ? FINISHED_TASK_TTL : RUNNING_TASK_TTL;
    if (task.updatedAt < now - ttl) tasks.delete(id);
  }
}

function limitUploadConcurrency(req, res, next) {
  if (activeUploads >= MAX_ACTIVE_UPLOADS) {
    return res.status(429).json({ error: '当前上传任务较多，请稍后再试' });
  }
  activeUploads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
  res.on('finish', release);
  res.on('close', release);
  next();
}

function assertUploadLimits(files) {
  const allFiles = [...(files.images || []), ...(files.mask || [])];
  const totalSize = allFiles.reduce((sum, file) => sum + (file.size || file.buffer?.length || 0), 0);
  if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
    const error = new Error('单次上传总大小不能超过 200MB');
    error.status = 413;
    throw error;
  }
  for (const file of allFiles) {
    const detectedMime = detectImageMime(file.buffer);
    if (!ALLOWED_IMAGE_MIME_TYPES.has(detectedMime)) {
      const error = new Error('仅支持 PNG、JPEG、WebP 图片');
      error.status = 400;
      throw error;
    }
    file.mimetype = detectedMime;
  }
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

async function readJsonResponse(response, apiUrl) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const requestId = response.headers.get('x-request-id') || response.headers.get('cf-ray') || '';
  if (!contentType.includes('application/json')) {
    const text = await readLimitedText(response, MAX_UPSTREAM_ERROR_BYTES).catch(() => '');
    const preview = text.trim().slice(0, 120);
    throw new Error(`上游 API 返回的不是 JSON（请求：${apiUrl}，状态：${response.status}，类型：${contentType || 'unknown'}${requestId ? `，请求ID：${requestId}` : ''}）。响应开头：${preview || '空响应'}`);
  }
  return readLimitedJson(response, MAX_UPSTREAM_JSON_BYTES);
}

async function readLimitedText(response, maxBytes) {
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw createHttpError('上游 API 响应过大', 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readLimitedJson(response, maxBytes) {
  const text = await readLimitedText(response, maxBytes);
  return JSON.parse(text);
}

async function fetchWithTimeout(apiUrl, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  try {
    console.log(`[proxy] ${options.method || 'GET'} ${apiUrl}`);
    const response = await fetchSafe(apiUrl, { ...options, signal: controller.signal });
    if (!response.ok) {
      const errorText = await readLimitedText(response, MAX_UPSTREAM_ERROR_BYTES).catch(() => `HTTP ${response.status}: ${response.statusText}`);
      const preview = errorText.trim().slice(0, 500);
      const err = new Error(preview || `HTTP ${response.status}: ${response.statusText}`);
      err.status = response.status;
      throw err;
    }
    return readJsonResponse(response, apiUrl);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSafe(apiUrl, options, redirectCount = 0) {
  const agent = await createSafeAgent(apiUrl);
  const response = await fetch(apiUrl, { ...options, agent, redirect: 'manual' });
  if (![301, 302, 303, 307, 308].includes(response.status)) return response;
  const location = response.headers.get('location');
  if (!location) return response;
  if (redirectCount >= MAX_REDIRECTS) throw createHttpError('上游 API 重定向次数过多', 502);
  if (options.body && typeof options.body !== 'string' && !Buffer.isBuffer(options.body)) throw createHttpError('上游 API 重定向无法安全转发上传内容', 502);
  const nextUrl = new URL(location, apiUrl).toString();
  const current = new URL(apiUrl);
  const next = new URL(nextUrl);
  if (current.origin !== next.origin) throw createHttpError('上游 API 不允许跨源重定向', 502);
  if (current.protocol === 'https:' && next.protocol === 'http:') throw createHttpError('上游 API 不允许从 HTTPS 重定向到 HTTP', 502);
  const nextOptions = { ...options };
  if (response.status === 303) {
    nextOptions.method = 'GET';
    delete nextOptions.body;
    if (nextOptions.headers) {
      nextOptions.headers = { ...nextOptions.headers };
      delete nextOptions.headers['Content-Type'];
      delete nextOptions.headers['content-type'];
    }
  }
  return fetchSafe(nextUrl, nextOptions, redirectCount + 1);
}

function assertResponseModel(model) {
  if (!model) return DEFAULT_RESPONSE_MODEL;
  if (RESPONSE_MODELS.has(model)) return model;
  throw createHttpError(`不支持的流式模型：${model}`);
}

function buildResponseTool({ quality, size, partialImages, action }) {
  const tool = { type: 'image_generation', action, partial_images: partialImages };
  if (quality && quality !== 'auto') tool.quality = quality;
  if (size && size !== 'auto') tool.size = size;
  return tool;
}

function extractResponseImage(response) {
  if (response?.type === 'image_generation_call' && response.result) return response.result;
  if (response?.item?.type === 'image_generation_call' && response.item.result) return response.item.result;
  if (response?.output_item?.type === 'image_generation_call' && response.output_item.result) return response.output_item.result;
  const outputs = Array.isArray(response?.output) ? response.output : [];
  const imageCall = outputs.find(output => output?.type === 'image_generation_call' && output.result);
  return imageCall?.result || null;
}

async function fetchResponseStreamTask(task, apiUrl, { input, quality, size, config, model, action = 'generate' }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  let buffer = '';
  let eventLines = [];
  let finalImage = null;
  let finalResponse = null;
  let totalBytes = 0;
  let currentEventBytes = 0;

  function handleEventData(event) {
    const payload = event.join('\n');
    if (!payload || payload === '[DONE]') return;
    if (Buffer.byteLength(payload, 'utf8') > MAX_SSE_EVENT_BYTES) throw createHttpError('上游 API 流式事件过大', 502);
    let data;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      return;
    }

    if (data.type === 'response.image_generation_call.partial_image' && data.partial_image_b64) {
      const partial = { index: data.partial_image_index ?? task.partials.length, b64_json: data.partial_image_b64, createdAt: Date.now() };
      updateTask(task, { partials: [...task.partials, partial].slice(-3) });
      return;
    }

    const image = extractResponseImage(data.response || data);
    if (image) finalImage = image;
    if (data.type === 'response.completed' && data.response) finalResponse = data.response;
    if (data.type === 'response.failed' || data.type === 'response.error' || data.type === 'error' || data.error) {
      throw new Error(data.response?.error?.message || data.error?.message || data.error || 'Responses API 生成失败');
    }
  }

  function processSseLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line === '') {
      if (eventLines.length) {
        handleEventData(eventLines);
        eventLines = [];
        currentEventBytes = 0;
      }
      return;
    }
    if (line.startsWith('data:')) {
      const dataLine = line.slice(5).trimStart();
      currentEventBytes += Buffer.byteLength(dataLine, 'utf8') + 1;
      if (currentEventBytes > MAX_SSE_EVENT_BYTES) throw createHttpError('上游 API 流式事件过大', 502);
      eventLines.push(dataLine);
    }
  }

  try {
    console.log(`[proxy] POST ${apiUrl} (stream)`);
    const response = await fetchSafe(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key.trim()}` },
      body: JSON.stringify({
        model: assertResponseModel(model),
        input,
        stream: true,
        tools: [buildResponseTool({ quality, size, partialImages: 3, action })],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await readLimitedText(response, MAX_UPSTREAM_ERROR_BYTES).catch(() => `HTTP ${response.status}: ${response.statusText}`);
      const preview = errorText.trim().slice(0, 500);
      const err = new Error(preview || `HTTP ${response.status}: ${response.statusText}`);
      err.status = response.status;
      throw err;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const data = await readLimitedJson(response, MAX_UPSTREAM_JSON_BYTES);
      const image = extractResponseImage(data.response || data);
      if (!image) throw new Error('API 响应中没有图片数据');
      return { data: [{ b64_json: image }], response: data.response || data, streamed: false };
    }

    for await (const chunk of response.body) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_SSE_TOTAL_BYTES) throw createHttpError('上游 API 流式响应过大', 502);
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) throw createHttpError('上游 API 流式响应缓冲过大', 502);
      let newlineAt;
      while ((newlineAt = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        processSseLine(line);
      }
    }

    if (buffer.trim()) {
      processSseLine(buffer);
      buffer = '';
    }
    if (eventLines.length) handleEventData(eventLines);

    finalImage = finalImage || extractResponseImage(finalResponse);
    if (!finalImage) throw new Error('Responses API 响应中没有图片数据');
    return { data: [{ b64_json: finalImage }], response: finalResponse || null, streamed: true };
  } finally {
    clearTimeout(timeout);
  }
}

function fileToDataUrl(file) {
  const mime = file.mimetype || 'image/png';
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

function buildResponseEditInput(prompt, files) {
  const content = [{ type: 'input_text', text: prompt }];
  for (const file of files.images) {
    content.push({ type: 'input_image', image_url: fileToDataUrl(file) });
  }
  return [{ role: 'user', content }];
}

function buildEditForm({ prompt, quality, size, format, files }) {
  const form = new FormDataNode();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  if (quality && quality !== 'auto') form.append('quality', quality);
  if (size && size !== 'auto') form.append('size', size);
  if (format && format !== 'png') form.append('output_format', format);

  for (let i = 0; i < files.images.length; i++) {
    const img = files.images[i];
    form.append('image[]', img.buffer, { filename: img.originalname || `image_${i}.png`, contentType: img.mimetype || 'image/png' });
  }
  if (files.mask?.[0]) {
    const mask = files.mask[0];
    form.append('mask', mask.buffer, { filename: mask.originalname || 'mask.png', contentType: mask.mimetype || 'image/png' });
  }
  return form;
}

function sendProxyError(res, err) {
  const status = err.name === 'AbortError' ? 504 : (err.status || 500);
  const message = err.name === 'AbortError' ? '请求超时' : err.message;
  res.status(status).json({ error: message });
}

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, quality, size, n, format, config, stream = true, model } = req.body;
    if (!validateConfig(config)) return res.status(400).json({ error: '请先设置 API URL 和 Key' });
    const apiBaseUrl = await assertSafeApiUrl(config.url);
    if (!validatePrompt(prompt)) return res.status(400).json({ error: '请输入 1-20000 字的提示词' });
    const imageSize = normalizeImageSize(size);

    let task;
    if (stream !== false) {
      const responseModel = assertResponseModel(model);
      task = createTask('generate');
      const apiUrl = `${apiBaseUrl}/responses`;
      runTask(task, () => fetchResponseStreamTask(task, apiUrl, { input: prompt, quality, size: imageSize, config, model: responseModel, action: 'generate' }));
    } else {
      task = createTask('generate');
      const apiUrl = `${apiBaseUrl}/images/generations`;
      const body = { model: 'gpt-image-2', prompt };
      if (quality && quality !== 'auto') body.quality = quality;
      if (imageSize && imageSize !== 'auto') body.size = imageSize;
      if (n && Number(n) > 1) body.n = Number(n);
      if (format && format !== 'png') body.output_format = format;
      runTask(task, () => fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key.trim()}` },
        body: JSON.stringify(body),
      }));
    }
    res.status(202).json({ taskId: task.id, status: task.status });
  } catch (err) {
    sendProxyError(res, err);
  }
});

app.post('/api/edit', limitUploadConcurrency, upload.fields([{ name: 'images', maxCount: 10 }, { name: 'mask', maxCount: 1 }]), async (req, res) => {
  try {
    const { prompt, quality, size, format, stream = 'true', model } = req.body;
    let config;
    try {
      config = typeof req.body.config === 'string' ? JSON.parse(req.body.config) : req.body.config;
    } catch (err) {
      return res.status(400).json({ error: '配置格式错误' });
    }
    if (!validateConfig(config)) return res.status(400).json({ error: '请先设置 API URL 和 Key' });
    const apiBaseUrl = await assertSafeApiUrl(config.url);
    if (!validatePrompt(prompt)) return res.status(400).json({ error: '请输入 1-20000 字的提示词' });
    const imageSize = normalizeImageSize(size);
    if (!req.files?.images?.length) return res.status(400).json({ error: '图生图需要至少一张图片' });
    assertUploadLimits(req.files);
    if (stream !== 'false' && req.files.mask?.length) return res.status(400).json({ error: 'Responses 模式暂不支持 mask，请切换到 Image API 模式' });

    const files = {
      images: req.files.images,
      mask: req.files.mask,
    };
    let task;
    if (stream !== 'false') {
      const responseModel = assertResponseModel(model);
      task = createTask('edit');
      runTask(task, () => {
        const input = buildResponseEditInput(prompt, files);
        return fetchResponseStreamTask(task, `${apiBaseUrl}/responses`, { input, quality, size: imageSize, config, model: responseModel, action: 'edit' });
      });
    } else {
      task = createTask('edit');
      runTask(task, () => {
        const form = buildEditForm({ prompt, quality, size: imageSize, format, files });
        return fetchWithTimeout(`${apiBaseUrl}/images/edits`, {
          method: 'POST',
          headers: { ...form.getHeaders(), 'Authorization': `Bearer ${config.key.trim()}` },
          body: form,
        });
      });
    }
    res.status(202).json({ taskId: task.id, status: task.status });
  } catch (err) {
    sendProxyError(res, err);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `API 路径不存在：${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过 20MB' : `图片上传失败：${err.message}`;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  }
  if (err) return res.status(400).json({ error: err.message || '请求格式错误' });
  next();
});

app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
