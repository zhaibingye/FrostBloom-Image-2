(function () {
  const $ = (sel) => document.querySelector(sel);
  const PENDING_TASKS_KEY = 'gptimg_pending_tasks';
  const PENDING_TASK_TTL = 10 * 60 * 1000;
  const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024;
  const MAX_UPLOAD_FILES = 10;
  const PRESET_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048']);

  const state = {
    config: { url: '', key: '' },
    quality: 'auto',
    size: 'auto',
    model: 'gpt-5.4-mini',
    streamMode: 'stream',
    editMode: false,
    editSourceTaskId: null,
    uploadFiles: [],
    taskCards: new Map(),
    isBusy: false,
    pendingSaveFailed: false,
  };

  function loadConfig() {
    try {
      const saved = localStorage.getItem('gptimg_config');
      if (saved) Object.assign(state.config, JSON.parse(saved));
      state.quality = localStorage.getItem('gptimg_quality') || 'auto';
      state.size = localStorage.getItem('gptimg_size') || 'auto';
      state.model = (localStorage.getItem('gptimg_model') || 'gpt-5.4-mini').replace(/^ggpt-/, 'gpt-');
      state.streamMode = localStorage.getItem('gptimg_stream_mode') || 'stream';
    } catch (e) { /* ignore */ }
  }

  function saveConfig() {
    try {
      localStorage.setItem('gptimg_config', JSON.stringify(state.config));
      localStorage.setItem('gptimg_quality', state.quality);
      localStorage.setItem('gptimg_size', state.size);
      localStorage.setItem('gptimg_model', state.model);
      localStorage.setItem('gptimg_stream_mode', state.streamMode);
    } catch (e) { /* ignore */ }
  }

  function showSettingsModal() {
    $('#apiUrl').value = state.config.url;
    $('#apiKey').value = state.config.key;
    $('#quality').value = state.quality;
    const isPresetSize = PRESET_SIZES.has(state.size);
    $('#size').value = isPresetSize ? state.size : 'custom';
    $('#customSize').value = isPresetSize ? '' : state.size;
    $('#settingsError').style.display = 'none';
    updateCustomSizeVisibility();
    $('#model').value = state.model;
    $('#streamMode').value = state.streamMode;
    $('#settingsModal').style.display = 'flex';
  }

  function hideSettingsModal() {
    $('#settingsModal').style.display = 'none';
  }

  function handleSaveSettings() {
    state.config.url = $('#apiUrl').value.trim();
    state.config.key = $('#apiKey').value.trim();
    state.quality = $('#quality').value;
    const size = getSelectedSize();
    if (!size.ok) {
      showSettingsError(size.error);
      return;
    }
    state.size = size.value;
    state.model = $('#model').value;
    state.streamMode = $('#streamMode').value;
    saveConfig();
    hideSettingsModal();
    updateSendBtn();
  }

  function updateCustomSizeVisibility() {
    $('#customSizeWrap').style.display = $('#size').value === 'custom' ? 'block' : 'none';
  }

  function showSettingsError(message) {
    const error = $('#settingsError');
    error.textContent = message;
    error.style.display = 'block';
  }

  function getSelectedSize() {
    if ($('#size').value !== 'custom') return { ok: true, value: $('#size').value };
    return normalizeImageSize($('#customSize').value);
  }

  function normalizeImageSize(size) {
    const normalized = String(size || '').trim().toLowerCase().replace(/\s+/g, '').replace('×', 'x');
    const match = /^(\d{1,4})x(\d{1,4})$/.exec(normalized);
    if (!match) return { ok: false, error: '请输入类似 2048x1152 的自定义尺寸' };

    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return { ok: false, error: '图片宽高必须是正整数' };
    }
    if (width > 3840 || height > 3840) return { ok: false, error: '最长边不能超过 3840px' };
    if (width % 16 !== 0 || height % 16 !== 0) return { ok: false, error: '宽高都必须是 16px 的倍数' };
    if (Math.max(width, height) / Math.min(width, height) > 3) return { ok: false, error: '长短边比例不能超过 3:1' };

    const pixels = width * height;
    if (pixels < 655360 || pixels > 8294400) return { ok: false, error: '总像素必须在 655,360 到 8,294,400 之间' };
    return { ok: true, value: `${width}x${height}` };
  }

  function updateSendBtn() {
    const hasPrompt = $('#promptInput').value.trim().length > 0;
    const hasConfig = state.config.url && state.config.key;
    $('#sendBtn').disabled = !(hasPrompt && hasConfig) || state.isBusy;
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  function showWelcome() {
    $('#welcomeScreen').style.display = 'flex';
  }

  function hideWelcome() {
    $('#welcomeScreen').style.display = 'none';
  }

  function createTaskCard(type, prompt, parentTaskId, uploadSources, cardId) {
    hideWelcome();

    const taskId = cardId || 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const parentCard = parentTaskId ? state.taskCards.get(parentTaskId) : null;
    const sourceImages = [];
    if (parentCard?.finalImageSrc) sourceImages.push(parentCard.finalImageSrc);
    if (uploadSources?.length) sourceImages.push(...uploadSources);

    const card = document.createElement('div');
    card.className = 'task-card';
    card.id = `task-${taskId}`;
    card.dataset.time = String(Date.now());
    card.innerHTML = `
      <div class="task-card-header">
        <span class="task-badge">${type === 'edit' ? '编辑' : '生成'}</span>
      </div>
      <div class="task-card-prompt">${escapeHtml(prompt)}</div>
      <div class="task-card-body">
        <div class="task-card-status">
          <div class="spinner"></div>
          <span>正在${type === 'edit' ? '编辑' : '生成'}图像...</span>
        </div>
      </div>
      <div class="task-card-image-container" style="display:none;"></div>
      <div class="task-card-actions" style="display:none;"></div>
    `;
    renderSourceImages(card, sourceImages);

    $('#feed').appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'end' });

    state.taskCards.set(taskId, { element: card, finalImageSrc: null, type });
    updateTaskList();
    return taskId;
  }

  function isSafeImageSrc(src) {
    return /^data:image\/(png|jpe?g|webp);base64,/i.test(src) || /^https?:\/\//i.test(src);
  }

  function createImage(src, alt) {
    const img = document.createElement('img');
    img.alt = alt;
    if (typeof src === 'string' && isSafeImageSrc(src)) img.src = src;
    return img;
  }

  function renderSourceImages(card, sourceImages) {
    const safeSources = sourceImages.filter(src => typeof src === 'string' && isSafeImageSrc(src));
    if (!safeSources.length) return;

    const source = document.createElement('div');
    source.className = 'task-card-source';

    const label = document.createElement('div');
    label.className = 'task-card-source-label';
    label.textContent = '参考图片';
    source.appendChild(label);

    const list = document.createElement('div');
    list.className = 'task-card-source-list';
    safeSources.forEach((src, index) => {
      const item = document.createElement('div');
      item.className = 'task-card-source-item';
      item.appendChild(createImage(src, `图 ${index + 1}`));

      const badge = document.createElement('span');
      badge.className = 'task-card-source-index';
      badge.textContent = `图 ${index + 1}`;
      item.appendChild(badge);
      list.appendChild(item);
    });
    source.appendChild(list);
    card.prepend(source);
  }

  function setTaskError(taskId, error) {
    const cardData = state.taskCards.get(taskId);
    if (!cardData) return;
    const bodyEl = cardData.element.querySelector('.task-card-body');
    bodyEl.innerHTML = `<div class="task-card-error">${escapeHtml(error)}</div>`;
    updateTaskList();
  }

  function setTaskPartial(taskId, partials) {
    const cardData = state.taskCards.get(taskId);
    if (!cardData || !partials?.length || cardData.finalImageSrc) return;

    const partial = partials[partials.length - 1];
    let imgSrc;
    try {
      imgSrc = base64ImageToDataUrl(partial.b64_json);
    } catch (err) {
      return;
    }
    const bodyEl = cardData.element.querySelector('.task-card-body');
    bodyEl.innerHTML = `
      <div class="task-card-status">
        <div class="spinner"></div>
        <span>正在生成图像，已收到第 ${partials.length} 张预览...</span>
      </div>`;

    const container = cardData.element.querySelector('.task-card-image-container');
    container.style.display = 'block';
    container.innerHTML = `
      <div class="task-card-image-wrap streaming-preview">
        <div class="streaming-preview-badge">流式预览</div>
      </div>`;
    container.querySelector('.task-card-image-wrap').prepend(createImage(imgSrc, '流式预览'));
    updateTaskList();
  }

  function setTaskFinal(taskId, data) {
    const cardData = state.taskCards.get(taskId);
    if (!cardData) return false;

    const image = data?.data?.find(item => item.b64_json || item.url);
    if (!image) {
      setTaskError(taskId, 'API 响应中没有图片数据');
      return false;
    }

    let imgSrc;
    try {
      imgSrc = image.b64_json ? base64ImageToDataUrl(image.b64_json) : image.url;
    } catch (err) {
      setTaskError(taskId, err.message || 'API 返回的图片数据异常');
      return false;
    }
    if (!isSafeImageSrc(imgSrc)) {
      setTaskError(taskId, 'API 返回了不支持的图片地址');
      return false;
    }
    cardData.finalImageSrc = imgSrc;
    cardData.element.querySelector('.task-card-body').innerHTML = '';

    const container = cardData.element.querySelector('.task-card-image-container');
    container.style.display = 'block';
    container.innerHTML = `
      <div class="task-card-image-wrap">
        <div class="task-card-image-overlay">
          <button class="image-action-btn edit-btn" title="编辑此图片">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="image-action-btn download-btn" title="下载图片">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="image-action-btn fullscreen-btn" title="查看大图">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          </button>
        </div>
      </div>`;
    const resultImg = createImage(imgSrc, '生成结果');
    resultImg.style.cursor = 'pointer';
    container.querySelector('.task-card-image-wrap').prepend(resultImg);

    container.querySelector('.edit-btn').addEventListener('click', () => enterEditMode(taskId));
    container.querySelector('.download-btn').addEventListener('click', () => downloadImage(taskId));
    container.querySelector('.fullscreen-btn').addEventListener('click', () => showImageModal(imgSrc));
    container.querySelector('img').addEventListener('click', () => showImageModal(imgSrc));

    const actionsEl = cardData.element.querySelector('.task-card-actions');
    actionsEl.style.display = 'flex';
    actionsEl.innerHTML = `
      <button class="task-action-btn edit-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        编辑图片
      </button>
      <button class="task-action-btn download-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        下载
      </button>
      <button class="task-action-btn danger delete-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        删除
      </button>`;
    actionsEl.querySelector('.edit-action').addEventListener('click', () => enterEditMode(taskId));
    actionsEl.querySelector('.download-action').addEventListener('click', () => downloadImage(taskId));
    actionsEl.querySelector('.delete-action').addEventListener('click', () => deleteTask(taskId));
    updateTaskList();
    return true;
  }

  function enterEditMode(sourceTaskId) {
    const cardData = state.taskCards.get(sourceTaskId);
    if (!cardData?.finalImageSrc) return;
    state.editMode = true;
    state.editSourceTaskId = sourceTaskId;
    $('#editIndicator').style.display = 'flex';
    $('#editPreview').src = cardData.finalImageSrc;
    $('#promptInput').placeholder = '描述你想要对图片进行的修改...';
    $('#promptInput').focus();
    autoResize($('#promptInput'));
    updateSendBtn();
  }

  function exitEditMode() {
    state.editMode = false;
    state.editSourceTaskId = null;
    $('#editIndicator').style.display = 'none';
    $('#promptInput').placeholder = '描述你想要生成或编辑的图像...';
    autoResize($('#promptInput'));
  }

  async function downloadImage(taskId) {
    const cardData = state.taskCards.get(taskId);
    if (!cardData?.finalImageSrc) return;
    let objectUrl;

    try {
      const blob = await imageSrcToBlob(cardData.finalImageSrc);
      objectUrl = URL.createObjectURL(blob);
      triggerDownload(objectUrl, `image_${Date.now()}.${getImageExtension(blob.type)}`);
    } catch (err) {
      if (/^https?:\/\//i.test(cardData.finalImageSrc)) {
        triggerDownload(cardData.finalImageSrc, `image_${Date.now()}.png`, true);
        return;
      }
      alert(`下载失败：${err.message || '图片数据异常'}`);
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  }

  function triggerDownload(href, filename, openInNewTab) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    if (openInNewTab) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function getImageExtension(mime) {
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    return 'png';
  }

  async function imageSrcToBlob(src) {
    if (!src.startsWith('data:')) {
      const res = await fetch(src);
      if (!res.ok) throw new Error('图片请求失败');
      return res.blob();
    }

    const [header, base64] = src.split(',');
    if (!base64) throw new Error('图片数据不完整');
    const declaredMime = ((header.match(/data:([^;]+)/) || [])[1] || '').toLowerCase();
    const bytes = base64ToBytes(base64);
    const mime = detectImageMime(bytes);
    if (!mime || mime !== declaredMime) throw new Error('图片 MIME 与文件内容不匹配');
    return new Blob([bytes], { type: mime });
  }

  function base64ImageToDataUrl(base64) {
    const bytes = base64ToBytes(base64);
    const mime = detectImageMime(bytes);
    if (!mime) throw new Error('API 返回的图片数据格式不受支持');
    return `data:${mime};base64,${base64}`;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function detectImageMime(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    return '';
  }

  function isAllowedUploadFile(file) {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return true;
    return /\.(png|jpe?g|webp)$/i.test(file.name || '');
  }

  async function detectFileMime(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    return detectImageMime(bytes);
  }

  function deleteTask(taskId, skipConfirm) {
    const cardData = state.taskCards.get(taskId);
    if (!cardData) return;
    if (!skipConfirm && !confirm('确定删除这条记录吗？')) return;
    if (state.editSourceTaskId === taskId) exitEditMode();
    cardData.element.remove();
    state.taskCards.delete(taskId);
    removePendingTaskByCardId(taskId);
    updateTaskList();
    if (state.taskCards.size === 0) showWelcome();
  }

  function clearTimeline() {
    if (!state.taskCards.size) return;
    if (!confirm('确定清空当前时间线吗？')) return;
    document.querySelectorAll('.task-card').forEach(el => el.remove());
    state.taskCards.clear();
    clearPendingTasks();
    updateTaskList();
    showWelcome();
    exitEditMode();
    clearUploadFiles();
    $('#promptInput').focus();
  }

  function showImageModal(src) {
    $('#imageModalImg').src = src;
    $('#imageModal').style.display = 'flex';
  }

  function hideImageModal() {
    $('#imageModal').style.display = 'none';
  }

  async function startGeneration() {
    const prompt = $('#promptInput').value.trim();
    if (!prompt) return;
    if (!state.config.url || !state.config.key) {
      showSettingsModal();
      return;
    }

    const isEdit = (state.editMode && state.editSourceTaskId) || state.uploadFiles.length > 0;
    const sourceTaskId = state.editSourceTaskId;
    $('#promptInput').value = '';
    autoResize($('#promptInput'));
    updateSendBtn();

    if (isEdit) {
      await startEdit(prompt, sourceTaskId);
    } else {
      await startGenerate(prompt);
    }
  }

  async function startGenerate(prompt) {
    const taskId = createTaskCard('generate', prompt, null);
    state.isBusy = true;
    updateSendBtn();
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          quality: state.quality,
          size: state.size,
          model: state.model,
          stream: state.streamMode === 'stream',
          config: state.config,
        }),
      });
      const data = await readJsonOrThrow(res, '/api/generate');
      if (!res.ok || data.error) {
        setTaskError(taskId, data.error || '生成失败');
        return;
      }
      if (!data.taskId) {
        setTaskError(taskId, '任务提交失败：响应中没有 taskId');
        return;
      }
      const pending = { taskId: data.taskId, cardId: taskId, type: 'generate', prompt, createdAt: Date.now() };
      addPendingTask(pending);
      pollTask(data.taskId, taskId);
    } catch (err) {
      setTaskError(taskId, err.message || '生成失败');
    } finally {
      state.isBusy = false;
      updateSendBtn();
    }
  }

  async function startEdit(prompt, sourceTaskId) {
    if ((sourceTaskId ? 1 : 0) + state.uploadFiles.length > MAX_UPLOAD_FILES) {
      const taskId = createTaskCard('edit', prompt, sourceTaskId);
      setTaskError(taskId, `最多只能提交 ${MAX_UPLOAD_FILES} 张图片`);
      return;
    }
    const uploadSources = await Promise.all(state.uploadFiles.map(fileToDataUrl));
    const taskId = createTaskCard('edit', prompt, sourceTaskId, uploadSources);
    const sourceImages = Array.from(state.taskCards.get(taskId)?.element.querySelectorAll('.task-card-source-list img') || []).map(img => img.src);
    const formData = new FormData();
    formData.append('prompt', buildNumberedEditPrompt(prompt, sourceTaskId));
    formData.append('quality', state.quality);
    formData.append('size', state.size);
    formData.append('model', state.model);
    formData.append('stream', String(state.streamMode === 'stream'));
    formData.append('config', JSON.stringify(state.config));

    if (sourceTaskId) {
      const source = state.taskCards.get(sourceTaskId);
      if (source?.finalImageSrc) {
        formData.append('images', await imageSrcToFile(source.finalImageSrc, 'source_image.png'));
      }
      exitEditMode();
    }

    for (const file of state.uploadFiles) {
      formData.append('images', file);
    }
    clearUploadFiles();

    state.isBusy = true;
    updateSendBtn();
    try {
      const res = await fetch('/api/edit', { method: 'POST', body: formData });
      const data = await readJsonOrThrow(res, '/api/edit');
      if (!res.ok || data.error) {
        setTaskError(taskId, data.error || '编辑失败');
        return;
      }
      if (!data.taskId) {
        setTaskError(taskId, '任务提交失败：响应中没有 taskId');
        return;
      }
      const pending = { taskId: data.taskId, cardId: taskId, type: 'edit', prompt, sourceImages, createdAt: Date.now() };
      addPendingTask(pending);
      pollTask(data.taskId, taskId);
    } catch (err) {
      setTaskError(taskId, err.message || '编辑失败');
    } finally {
      state.isBusy = false;
      updateSendBtn();
    }
  }

  async function pollTask(serverTaskId, cardId) {
    if (!state.taskCards.has(cardId)) return;

    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(serverTaskId)}`, { cache: 'no-store' });
      const data = await readJsonOrThrow(res, `/api/tasks/${serverTaskId}`);
      if (!res.ok || data.error) {
        setTaskError(cardId, data.error || '任务查询失败');
        removePendingTask(serverTaskId);
        return;
      }

      if (data.status === 'completed') {
        setTaskFinal(cardId, data.result);
        removePendingTask(serverTaskId);
        return;
      }

      if (data.partials?.length) setTaskPartial(cardId, data.partials);

      if (data.status === 'failed') {
        setTaskError(cardId, data.error || '任务失败');
        removePendingTask(serverTaskId);
        return;
      }
    } catch (err) {
      // Keep polling so brief disconnects or tab backgrounding can recover.
    }

    if (state.taskCards.has(cardId)) setTimeout(() => pollTask(serverTaskId, cardId), 2000);
  }

  function getPendingTasks() {
    let tasks;
    try { tasks = JSON.parse(localStorage.getItem(PENDING_TASKS_KEY) || '[]'); } catch (e) { return []; }
    const now = Date.now();
    const activeTasks = tasks.filter(task => !task.createdAt || now - task.createdAt <= PENDING_TASK_TTL);
    if (activeTasks.length !== tasks.length) savePendingTasks(activeTasks);
    return activeTasks;
  }

  function savePendingTasks(tasks) {
    try {
      localStorage.setItem(PENDING_TASKS_KEY, JSON.stringify(tasks));
      state.pendingSaveFailed = false;
      return true;
    } catch (e) {
      try {
        localStorage.setItem(PENDING_TASKS_KEY, JSON.stringify(tasks.map(({ sourceImages, ...task }) => task)));
        state.pendingSaveFailed = false;
        return true;
      } catch (err) {
        state.pendingSaveFailed = true;
        return false;
      }
    }
  }

  function addPendingTask(task) {
    const tasks = getPendingTasks().filter(item => item.taskId !== task.taskId);
    tasks.push(task);
    return savePendingTasks(tasks);
  }

  function removePendingTask(serverTaskId) {
    savePendingTasks(getPendingTasks().filter(task => task.taskId !== serverTaskId));
  }

  function removePendingTaskByCardId(cardId) {
    savePendingTasks(getPendingTasks().filter(task => task.cardId !== cardId));
  }

  function clearPendingTasks() {
    savePendingTasks([]);
  }

  function restorePendingTasks() {
    for (const task of getPendingTasks()) {
      if (state.taskCards.has(task.cardId)) continue;
      const cardId = createTaskCard(task.type, task.prompt, null, task.sourceImages || [], task.cardId);
      pollTask(task.taskId, cardId);
    }
  }

  function updateTaskList() {
    const listEl = $('#taskList');
    const emptyEl = $('#emptyHistory');
    const items = [];

    for (const [id, data] of state.taskCards) {
      const promptEl = data.element.querySelector('.task-card-prompt');
      const prompt = promptEl ? promptEl.textContent : '';
      const statusBody = data.element.querySelector('.task-card-body');
      let status = 'completed';
      if (statusBody && statusBody.querySelector('.task-card-status')) status = 'processing';
      if (statusBody && statusBody.querySelector('.task-card-error')) status = 'error';
      items.push({ id, prompt, status, type: data.type, time: Number(data.element.dataset.time) || 0 });
    }

    items.sort((a, b) => a.time - b.time);
    if (items.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'flex';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.innerHTML = '';
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'task-item';
      el.dataset.taskId = item.id;

      const typeEl = document.createElement('span');
      typeEl.className = 'task-item-type';
      typeEl.textContent = item.type === 'edit' ? '编辑' : '生成';

      const promptEl = document.createElement('span');
      promptEl.className = 'task-item-prompt';
      promptEl.textContent = item.prompt.substring(0, 30);

      const statusEl = document.createElement('span');
      statusEl.className = `task-item-status ${item.status}`;
      statusEl.textContent = item.status === 'processing' ? '处理中' : item.status === 'error' ? '错误' : '完成';

      el.append(typeEl, promptEl, statusEl);
      listEl.appendChild(el);
    });

    listEl.querySelectorAll('.task-item').forEach(el => {
      el.addEventListener('click', () => {
        const card = document.getElementById(`task-${el.dataset.taskId}`);
        if (card) card.scrollIntoView({ behavior: 'smooth' });
      });
    });
  }

  async function handleFileUpload(files) {
    const selected = Array.from(files);
    const sourceCount = state.editMode && state.editSourceTaskId ? 1 : 0;
    const availableSlots = MAX_UPLOAD_FILES - sourceCount - state.uploadFiles.length;
    if (availableSlots <= 0) {
      alert(`最多只能提交 ${MAX_UPLOAD_FILES} 张图片`);
      return;
    }

    if (selected.length > availableSlots) alert(`最多还能上传 ${availableSlots} 张图片，已忽略多余文件`);
    for (const file of selected) {
      if (state.uploadFiles.length + sourceCount >= MAX_UPLOAD_FILES) break;
      if (!isAllowedUploadFile(file)) {
        alert('仅支持 PNG、JPEG、WebP 图片');
        continue;
      }
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        alert('单张图片不能超过 20MB');
        continue;
      }
      const totalSize = state.uploadFiles.reduce((sum, item) => sum + item.size, 0) + file.size;
      if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
        alert('单次上传总大小不能超过 200MB');
        continue;
      }
      const detectedMime = await detectFileMime(file).catch(() => '');
      if (!detectedMime || (file.type && file.type !== 'application/octet-stream' && detectedMime !== file.type)) {
        alert('图片文件内容与格式不匹配，仅支持 PNG、JPEG、WebP');
        continue;
      }
      state.uploadFiles.push(file);
      const item = document.createElement('div');
      item.className = 'upload-preview-item';
      const img = document.createElement('img');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.innerHTML = '&times;';
      removeBtn.addEventListener('click', () => {
        const idx = state.uploadFiles.indexOf(file);
        if (idx >= 0) state.uploadFiles.splice(idx, 1);
        item.remove();
        if (state.uploadFiles.length === 0) $('#uploadPreview').style.display = 'none';
        updateSendBtn();
      });
      item.appendChild(img);
      item.appendChild(removeBtn);
      $('#uploadPreview').appendChild(item);

      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }
    if (state.uploadFiles.length > 0) $('#uploadPreview').style.display = 'flex';
    updateSendBtn();
  }

  function buildNumberedEditPrompt(prompt, sourceTaskId) {
    const lines = [];
    let imageNumber = 1;

    if (sourceTaskId) {
      lines.push(`图片 ${imageNumber} 是当前编辑的来源图片。`);
      imageNumber += 1;
    }

    for (const file of state.uploadFiles) {
      lines.push(`图片 ${imageNumber} 是用户上传的参考图${file.name ? `（${file.name}）` : ''}。`);
      imageNumber += 1;
    }

    if (!lines.length) return prompt;
    return `请按以下编号理解输入图片：\n${lines.join('\n')}\n\n用户要求：${prompt}`;
  }

  async function readJsonOrThrow(res, path) {
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return res.json();

    const text = await res.text().catch(() => '');
    const preview = text.trim().slice(0, 120) || '空响应';
    throw new Error(`${path} 返回的不是 JSON。服务器部署时请确认 /api 请求已转发到 Node 服务。响应开头：${preview}`);
  }

  function clearUploadFiles() {
    state.uploadFiles = [];
    $('#uploadPreview').innerHTML = '';
    $('#uploadPreview').style.display = 'none';
  }

  async function imageSrcToFile(src, filename) {
    const blob = await imageSrcToBlob(src);
    return new File([blob], filename, { type: blob.type || 'image/png' });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('图片预览读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function init() {
    loadConfig();

    $('#settingsBtn').addEventListener('click', showSettingsModal);
    $('#settingsTopBtn').addEventListener('click', showSettingsModal);
    $('#closeModal').addEventListener('click', hideSettingsModal);
    $('#saveSettings').addEventListener('click', handleSaveSettings);
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideSettingsModal();
    });
    $('#toggleKeyBtn').addEventListener('click', () => {
      const input = $('#apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    $('#size').addEventListener('change', () => {
      updateCustomSizeVisibility();
      $('#settingsError').style.display = 'none';
      if ($('#size').value === 'custom') $('#customSize').focus();
    });
    $('#customSize').addEventListener('input', () => {
      $('#settingsError').style.display = 'none';
    });

    $('#sendBtn').addEventListener('click', startGeneration);
    $('#promptInput').addEventListener('input', () => {
      autoResize($('#promptInput'));
      updateSendBtn();
    });
    $('#promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        startGeneration();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (!state.isBusy && !state.pendingSaveFailed) return;
      e.preventDefault();
      e.returnValue = '';
    });

    $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) handleFileUpload(e.target.files);
      e.target.value = '';
    });
    $('#cancelEditBtn').addEventListener('click', exitEditMode);

    $('#closeImageModal').addEventListener('click', hideImageModal);
    $('#imageModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideImageModal();
    });

    $('#menuBtn').addEventListener('click', () => {
      const isMobile = window.matchMedia('(max-width: 768px)').matches;
      if (isMobile) {
        $('#sidebar').classList.toggle('open');
        $('#sidebarOverlay').classList.toggle('open');
        return;
      }
      $('#sidebar').classList.toggle('collapsed');
    });
    $('#sidebarOverlay').addEventListener('click', () => {
      $('#sidebar').classList.remove('open');
      $('#sidebarOverlay').classList.remove('open');
    });
    $('#newTaskBtn').addEventListener('click', () => {
      clearTimeline();
      $('#sidebar').classList.remove('open');
      $('#sidebarOverlay').classList.remove('open');
    });

    document.querySelectorAll('.welcome-card').forEach(card => {
      card.addEventListener('click', () => {
        $('#promptInput').value = card.dataset.prompt;
        autoResize($('#promptInput'));
        updateSendBtn();
        $('#promptInput').focus();
      });
    });

    if (!state.config.url || !state.config.key) setTimeout(showSettingsModal, 500);
    restorePendingTasks();
    updateSendBtn();
    updateTaskList();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
