// Background Service Worker

importScripts('file-rules.js');

const STORAGE_KEYS = {
  COOKIE: 'push115_cookie',
  AUTO_DETECT: 'push115_auto_detect',
  TASKS: 'push115_tasks',
};

const CONTENT_SCRIPT_ID = 'push115-content-script';
const TASK_MONITOR_ALARM = 'push115-task-monitor';
const TASK_MONITOR_PERIOD_MINUTES = 0.5;
const TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let taskMonitorRunning = false;

// ========== Dynamic Content Script Registration ==========

async function registerContentScripts() {
  try {
    await unregisterContentScripts();
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: ['path-utils.js', 'content.js'],
      runAt: 'document_idle',
    }]);
    console.log('[BG] Content scripts registered');
  } catch (e) {
    console.error('[BG] Failed to register content scripts:', e);
  }
}

async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['path-utils.js', 'content.js'],
        });
      } catch (e) {
        // Ignore tabs we can't inject into (e.g., chrome:// pages).
      }
    }
    console.log(`[BG] Injected content scripts into ${tabs.length} existing tabs`);
  } catch (e) {
    console.error('[BG] Failed to inject into existing tabs:', e);
  }
}

async function unregisterContentScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    console.log('[BG] Content scripts unregistered');
  } catch (e) {
    // Ignore error if not registered.
  }
}

async function syncContentScriptState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AUTO_DETECT);
  const autoDetect = data[STORAGE_KEYS.AUTO_DETECT] === true;
  if (autoDetect) {
    const hasPermission = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (hasPermission) {
      await registerContentScripts();
    } else {
      await chrome.storage.local.set({ [STORAGE_KEYS.AUTO_DETECT]: false });
      await unregisterContentScripts();
    }
  } else {
    await unregisterContentScripts();
  }
}

async function ensureTaskMonitorAlarm() {
  const existing = await chrome.alarms.get(TASK_MONITOR_ALARM);
  if (!existing) {
    await chrome.alarms.create(TASK_MONITOR_ALARM, {
      periodInMinutes: TASK_MONITOR_PERIOD_MINUTES,
    });
  }
}

function initializeBackground() {
  void syncContentScriptState();
  void ensureTaskMonitorAlarm();
  void processPendingTasks();
}

chrome.runtime.onInstalled.addListener(initializeBackground);
chrome.runtime.onStartup.addListener(initializeBackground);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TASK_MONITOR_ALARM) void processPendingTasks();
});

// Re-create the alarm after an extension reload as well as after browser startup.
void ensureTaskMonitorAlarm();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.AUTO_DETECT]) {
    void syncContentScriptState();
  }
});

// Listen for messages from content script and popup.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'API_REQUEST') {
    handleApiRequest(request, sendResponse);
    return true;
  } else if (request.action === 'GET_COOKIE') {
    handleGetCookie(request, sendResponse);
    return true;
  } else if (request.action === 'SET_COOKIE') {
    handleSetCookie(request, sendResponse);
    return true;
  } else if (request.action === 'NOTIFY') {
    handleNotify(request);
  } else if (request.action === 'REGISTER_CONTENT_SCRIPTS') {
    registerContentScripts()
      .then(() => injectIntoExistingTabs())
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (request.action === 'UNREGISTER_CONTENT_SCRIPTS') {
    unregisterContentScripts()
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (request.action === 'QUEUE_TASK') {
    queueTask(request.details || {})
      .then(task => sendResponse({ success: true, task }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (request.action === 'GET_TASKS') {
    readTaskRecords()
      .then(tasks => sendResponse({ success: true, tasks }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  } else if (request.action === 'RETRY_TASK') {
    retryTask(request.details?.taskId)
      .then(task => sendResponse({ success: true, task }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

// ========== 115 Authentication / API ==========

function parseCookieString(rawCookie) {
  if (!rawCookie) return '';
  if (typeof rawCookie === 'string') return rawCookie.trim();
  if (typeof rawCookie === 'object') {
    const parts = [];
    if (rawCookie.UID) parts.push(`UID=${rawCookie.UID}`);
    if (rawCookie.CID) parts.push(`CID=${rawCookie.CID}`);
    if (rawCookie.SEID) parts.push(`SEID=${rawCookie.SEID}`);
    return parts.join('; ');
  }
  return '';
}

function is115Host(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === '115.com' || hostname.endsWith('.115.com');
  } catch (e) {
    return false;
  }
}

async function getPersistedCookie() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.COOKIE);
  return data[STORAGE_KEYS.COOKIE] || '';
}

async function has115AuthCookies() {
  const cookies = await chrome.cookies.getAll({ domain: '.115.com' });
  const names = new Set(cookies.map(c => c.name));
  return names.has('UID') && names.has('CID') && names.has('SEID');
}

async function syncCookieStringToJar(cookieString, options = {}) {
  const { overwrite = true } = options;
  const expiresAt = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;
  const pairs = cookieString
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name || !value) continue;

    try {
      if (!overwrite) {
        const existing = await chrome.cookies.get({
          url: 'https://115.com/',
          name,
        });
        if (existing && existing.value) continue;
      }
      await chrome.cookies.set({
        url: 'https://115.com/',
        name,
        value,
        domain: '.115.com',
        path: '/',
        secure: true,
        sameSite: 'no_restriction',
        expirationDate: expiresAt,
      });
    } catch (e) {
      console.warn('Set cookie failed:', name, e?.message || e);
    }
  }
}

async function restorePersistedCookieIfMissing() {
  const hasAuth = await has115AuthCookies();
  if (hasAuth) return false;
  const saved = await getPersistedCookie();
  if (!saved) return false;
  await syncCookieStringToJar(saved, { overwrite: false });
  return true;
}

async function persistCookieToStorageAndJar(rawCookie) {
  const cookieString = parseCookieString(rawCookie);
  if (!cookieString) return '';

  await chrome.storage.local.set({ [STORAGE_KEYS.COOKIE]: cookieString });
  await syncCookieStringToJar(cookieString);
  return cookieString;
}

async function handleApiRequest(request, sendResponse) {
  try {
    const { url, method = 'GET', data = null, headers = {} } = request.details || {};
    if (!url) throw new Error('缺少请求地址');

    const normalizedMethod = String(method).toUpperCase();
    const requestHeaders = { ...headers };
    if (is115Host(url)) await restorePersistedCookieIfMissing();

    let body;
    if (!['GET', 'HEAD'].includes(normalizedMethod) && data) {
      if (typeof data === 'string') {
        body = data;
      } else {
        const params = new URLSearchParams();
        for (const key in data) params.append(key, data[key]);
        body = params;
      }
    }

    const response = await fetch(url, {
      method: normalizedMethod,
      headers: requestHeaders,
      body,
      credentials: 'include',
    });
    const responseText = await response.text();

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (e) {
      // Not JSON.
    }

    if (
      responseJson &&
      responseJson.state === 1 &&
      responseJson.data &&
      responseJson.data.cookie &&
      typeof url === 'string' &&
      url.includes('/login/qrcode/')
    ) {
      await persistCookieToStorageAndJar(responseJson.data.cookie);
    }

    sendResponse({
      success: true,
      data: responseJson || responseText,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    console.error('API Request Error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

function apiRequest(details) {
  return new Promise((resolve, reject) => {
    handleApiRequest({ details }, response => {
      if (response?.success) resolve(response.data);
      else reject(new Error(response?.error || '115 请求失败'));
    });
  });
}

async function handleGetCookie(request, sendResponse) {
  try {
    const cookies = await chrome.cookies.getAll({ domain: '.115.com' });
    let cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (!cookieString) {
      cookieString = await getPersistedCookie();
      if (cookieString) await syncCookieStringToJar(cookieString, { overwrite: false });
    }
    sendResponse({ success: true, cookie: cookieString });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function handleSetCookie(request, sendResponse) {
  try {
    const cookie = request?.details?.cookie;
    const persisted = await persistCookieToStorageAndJar(cookie);
    sendResponse({ success: true, cookie: persisted });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// ========== Persistent Task Queue ==========

function makeTaskId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeCid(value) {
  const cid = String(value ?? '').trim();
  return /^\d+$/.test(cid) ? cid : '0';
}

function extractMagnetHash(url) {
  try {
    const parsed = new URL(url);
    const xt = parsed.searchParams.get('xt') || '';
    const match = xt.match(/^urn:btih:([a-z0-9]{32,40})$/i);
    return match ? match[1].toLowerCase() : '';
  } catch (e) {
    return '';
  }
}

function extractMagnetName(url) {
  try {
    const parsed = new URL(url);
    return String(parsed.searchParams.get('dn') || '').trim();
  } catch (e) {
    return '';
  }
}

function normalizeCode(value) {
  const text = String(value || '')
    .toUpperCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[\[\]【】()]/g, ' ')
    .replace(/[@_.]/g, '-');
  const fc2 = text.match(/\b(FC2-(?:PPV-)?\d{5,7})\b/);
  if (fc2) return fc2[1];
  const general = text.match(/\b([A-Z]{2,6})[-\s]?(\d{2,5})(?:[-\s]?([A-Z]))?\b/);
  if (!general) return '';
  const invalid = new Set([
    'FULL',
    'H264',
    'HEVC',
    'MP4',
    'AVI',
    'MKV',
    'WMV',
    'JPG',
    'PNG',
    'COM',
    'NET',
    'WWW',
    'JAV',
    'HD',
    'FHD',
    'RESTORE',
    'UNCENSORED',
    'CHINESE',
    'ARCHIVE',
    'XXX',
  ]);
  if (invalid.has(general[1])) return '';
  return `${general[1]}-${general[2]}${general[3] ? `-${general[3]}` : ''}`;
}

function getRemoteTaskId(task) {
  return String(
    task?.info_hash || task?.infoHash || task?.hash || task?.task_id || task?.taskId || task?.id || '',
  ).trim();
}

function getRemoteTaskFolderCid(task) {
  return String(
    task?.file_id || task?.fileId || task?.dir_id || task?.dirId || task?.wppath_id || '',
  ).trim();
}

function getItemName(item) {
  return Push115FileRules.getFileName(item);
}

function getItemId(item) {
  const fid = item?.fid ?? item?.file_id ?? item?.fileId;
  return fid === undefined || fid === null ? '' : String(fid);
}

function apiOperationSucceeded(result) {
  return result?.state === true || result?.state === 1 || result?.state === '1';
}

function isFolderItem(item) {
  return Boolean(item && !item.sha && (item.cid || item.fid || item.file_id));
}

async function readTaskRecords() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
  return Array.isArray(data[STORAGE_KEYS.TASKS]) ? data[STORAGE_KEYS.TASKS] : [];
}

function taskIsActive(task) {
  return ['waiting', 'processing'].includes(task?.status);
}

function appendTaskLog(task, message) {
  const text = String(message || '').trim();
  if (!text) return;
  const logs = Array.isArray(task.logs) ? task.logs : [];
  logs.push({ at: Date.now(), message: text });
  task.logs = logs.slice(-60);
}

async function persistTask(task) {
  const tasks = await readTaskRecords();
  const index = tasks.findIndex(item => item.taskId === task.taskId);
  if (index >= 0) tasks[index] = task;
  else tasks.unshift(task);

  const active = tasks.filter(taskIsActive).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const history = tasks
    .filter(item => !taskIsActive(item))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  await chrome.storage.local.set({
    [STORAGE_KEYS.TASKS]: [...active.slice(0, 50), ...history.slice(0, 50)],
  });

  Promise.resolve(chrome.runtime.sendMessage({ action: 'TASK_UPDATED', task })).catch(() => {
    // No popup/content listener is expected when the page is closed.
  });
}

async function queueTask(details) {
  const now = Date.now();
  const remoteId = String(details.remoteId || details.info_hash || details.id || extractMagnetHash(details.magnet || details.url || '')).trim().toLowerCase();
  const magnet = String(details.magnet || details.url || '').trim();
  const remoteName = String(details.name || extractMagnetName(magnet) || '').trim();
  const code = normalizeCode(details.code) || normalizeCode(remoteName) || normalizeCode(details.title);
  const monitor = details.monitor !== false;
  const records = await readTaskRecords();
  const existing = records.find(task =>
    taskIsActive(task) && ((remoteId && task.remoteId === remoteId) || (magnet && task.magnet === magnet)),
  );

  const task = existing || {
    taskId: makeTaskId(),
    createdAt: now,
    attempts: 0,
    logs: [],
  };
  Object.assign(task, {
    remoteId: remoteId || task.remoteId || '',
    remoteName: remoteName || task.remoteName || '',
    magnet: magnet || task.magnet || '',
    code: code || task.code || '',
    title: String(details.title || task.title || '').trim(),
    source: String(details.source || task.source || '').trim(),
    savePathCid: normalizeCid(details.savePathCid || task.savePathCid || '0'),
    status: monitor ? 'waiting' : 'recorded',
    message: monitor ? '已登记后台监控' : '已记录任务元数据',
    updatedAt: now,
    lastError: '',
  });
  appendTaskLog(task, task.message);
  await persistTask(task);
  if (monitor) {
    await ensureTaskMonitorAlarm();
    void processPendingTasks();
  }
  return task;
}

async function retryTask(taskId) {
  const records = await readTaskRecords();
  const task = records.find(item => item.taskId === taskId);
  if (!task) throw new Error('找不到任务');
  task.status = 'waiting';
  task.attempts = 0;
  task.lastError = '';
  task.updatedAt = Date.now();
  appendTaskLog(task, '用户请求重新处理');
  await persistTask(task);
  await ensureTaskMonitorAlarm();
  void processPendingTasks();
  return task;
}

async function getConfigSnapshot() {
  return chrome.storage.local.get([
    'push115_auto_delete_small',
    'push115_delete_size_threshold',
    'push115_auto_organize',
    'push115_junk_extensions',
    'push115_preserve_extensions',
    'push115_clean_extensions',
    'push115_clean_images',
    'push115_clean_nfo',
  ]);
}

function buildCleanupRules(config = {}) {
  return Push115FileRules.buildRules({
    junkExtensions: config.push115_junk_extensions,
    preserveExtensions: config.push115_preserve_extensions,
    cleanExtensions: config.push115_clean_extensions,
    cleanImages: config.push115_clean_images === true,
    cleanNfo: config.push115_clean_nfo === true,
  });
}

async function getOfflineTasks() {
  const result = await apiRequest({
    url: 'https://115.com/web/lixian/?ct=lixian&ac=task_lists',
    method: 'GET',
  });
  if (result?.state) return result.tasks || result.data?.tasks || [];
  throw new Error('获取任务列表失败');
}

async function getFileList(cid = '0') {
  return apiRequest({
    url: `https://webapi.115.com/files?aid=1&cid=${cid}&o=user_ptime&asc=0&offset=0&show_dir=1&limit=500&snap=0&natsort=1`,
    method: 'GET',
  });
}

async function createFolder(parentCid, folderName) {
  return apiRequest({
    url: 'https://webapi.115.com/files/add',
    method: 'POST',
    data: { pid: parentCid, cname: folderName },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function moveFile(fid, targetCid) {
  return apiRequest({
    url: 'https://webapi.115.com/files/move',
    method: 'POST',
    data: { pid: targetCid, fid, move_proid: '' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function renameFile(fid, newName) {
  return apiRequest({
    url: 'https://webapi.115.com/files/edit',
    method: 'POST',
    data: { fid, name: newName },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function deleteFiles(fids) {
  const ids = (Array.isArray(fids) ? fids : [fids]).filter(Boolean);
  if (ids.length === 0) return { state: true };

  const params = new URLSearchParams();
  ids.forEach((fid, index) => params.append(`fid[${index}]`, fid));
  params.append('ignore_warn', '1');
  return apiRequest({
    url: 'https://webapi.115.com/rb/delete',
    method: 'POST',
    data: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function remoteTaskMatches(remoteTask, task) {
  const remoteId = getRemoteTaskId(remoteTask);
  if (task.remoteId && remoteId && task.remoteId.toLowerCase() === remoteId.toLowerCase()) return true;
  if (task.remoteId && !/^[a-z0-9]{32,40}$/i.test(task.remoteId)) return false;

  const remoteName = String(remoteTask?.name || '').trim();
  if (!remoteName || !task.remoteName) return false;
  const left = remoteName.toLowerCase();
  const right = task.remoteName.toLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

async function ensureUsableCid(candidateCid) {
  const cid = String(candidateCid || '').trim();
  if (!cid) return '';
  try {
    const list = await getFileList(cid);
    if (Array.isArray(list?.data)) return cid;
  } catch (e) {
    console.log('[BG] 目录不可用:', cid, e?.message || e);
  }
  return '';
}

async function resolveTaskFolder(savePathCid, taskName) {
  if (!taskName) return null;
  const list = await getFileList(savePathCid);
  if (!Array.isArray(list?.data)) return null;
  const folders = list.data.filter(isFolderItem);
  const normalize = value => String(value || '').trim().toLowerCase();
  const wanted = normalize(taskName);
  const exact = folders.find(item => normalize(getItemName(item)) === wanted);
  const fuzzy = exact || folders.find(item => normalize(getItemName(item)).includes(wanted));
  if (!fuzzy) return null;
  return {
    cid: String(fuzzy.cid || fuzzy.fid || fuzzy.file_id || ''),
    name: getItemName(fuzzy),
  };
}

async function cleanSmallFiles(cid, thresholdMB, rules = null) {
  const threshold = Number(thresholdMB);
  const thresholdBytes = Number.isFinite(threshold) && threshold > 0 ? threshold * 1024 * 1024 : 100 * 1024 * 1024;
  const folderQueue = [String(cid || '0')];
  const visitedFolders = new Set();
  const collectedFiles = [];

  while (folderQueue.length > 0) {
    const folderCid = folderQueue.shift();
    if (!folderCid || visitedFolders.has(folderCid)) continue;
    visitedFolders.add(folderCid);

    const fileList = await getFileList(folderCid);
    if (!Array.isArray(fileList?.data)) continue;
    for (const item of fileList.data) {
      if (isFolderItem(item)) {
        const childCid = String(item.cid || item.fid || item.file_id || '');
        if (childCid && !visitedFolders.has(childCid)) folderQueue.push(childCid);
      } else if (item?.sha) {
        collectedFiles.push(item);
      }
    }
  }

  const analyzed = Push115FileRules.analyzeFiles(collectedFiles, thresholdBytes, rules || Push115FileRules.buildRules());
  const candidates = analyzed
    .filter(entry => entry.decision.shouldDelete)
    .map(entry => ({
      fid: getItemId(entry.item),
      name: getItemName(entry.item),
      reason: entry.decision.reason,
    }))
    .filter(item => item.fid);

  for (let index = 0; index < candidates.length; index += 50) {
    const batch = candidates.slice(index, index + 50);
    const result = await deleteFiles(batch.map(item => item.fid));
    if (!apiOperationSucceeded(result)) throw new Error('删除候选文件失败');
  }

  return { count: candidates.length, files: candidates, scannedFolders: visitedFolders.size };
}

function normalizeCompareCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildSubtitleName(rawName, code) {
  const name = String(rawName || '');
  const extension = Push115FileRules.getExtension(name);
  const base = name.slice(0, Math.max(0, name.length - extension.length));
  const normalizedCode = normalizeCompareCode(code);
  const normalizedBase = normalizeCompareCode(base);
  if (normalizedBase.includes(normalizedCode)) return name;

  const suffixMatch = base.match(/(?:^|[-_.\s])((?:cd|disc|part)[-_.\s]?\d+|c|chs|cht|eng|jpn|sc|zh|en)$/i);
  const suffix = suffixMatch ? `-${suffixMatch[1].replace(/[-_.\s]+/g, '-').toUpperCase()}` : '';
  return `${code}${suffix}${extension}`;
}

function isSubtitle(item) {
  return ['.srt', '.ass', '.ssa', '.sup', '.vtt'].includes(Push115FileRules.getExtension(getItemName(item)));
}

async function organizeKnownTaskFolder(cid, task) {
  const list = await getFileList(cid);
  if (!Array.isArray(list?.data)) return { count: 0, main: '', subtitles: 0, folderRenamed: false };

  const code = normalizeCode(task.code);
  if (!code) return { count: 0, main: '', subtitles: 0, folderRenamed: false };

  const files = list.data.filter(item => item?.sha);
  const videos = files
    .filter(Push115FileRules.isVideo)
    .sort((left, right) => Push115FileRules.getSizeBytes(right) - Push115FileRules.getSizeBytes(left));
  let count = 0;
  let main = '';

  if (videos.length > 0) {
    const mainVideo = videos[0];
    const oldName = getItemName(mainVideo);
    const extension = Push115FileRules.getExtension(oldName);
    const newName = `${code}${extension}`;
    main = newName;
    if (oldName !== newName) {
      const result = await renameFile(getItemId(mainVideo), newName);
      if (apiOperationSucceeded(result)) count += 1;
    }
  }

  let subtitles = 0;
  for (const subtitle of files.filter(isSubtitle)) {
    const oldName = getItemName(subtitle);
    const newName = buildSubtitleName(oldName, code);
    if (oldName === newName) continue;
    const result = await renameFile(getItemId(subtitle), newName);
    if (apiOperationSucceeded(result)) {
      subtitles += 1;
      count += 1;
    }
  }

  let folderRenamed = false;
  if (String(cid) !== '0') {
    try {
      const result = await renameFile(cid, code);
      folderRenamed = apiOperationSucceeded(result);
    } catch (error) {
      console.warn('[BG] 任务文件夹改名失败:', error?.message || error);
    }
  }

  return { count, main, subtitles, folderRenamed };
}

async function organizeVideos(cid) {
  const list = await getFileList(cid);
  if (!Array.isArray(list?.data)) return 0;
  const files = list.data.filter(item => item?.sha && Push115FileRules.isVideo(item));
  let organizedCount = 0;

  for (const video of files) {
    const fileName = getItemName(video);
    const code = normalizeCode(fileName);
    if (!code) continue;

    let targetCid = '';
    const existing = list.data.find(item => isFolderItem(item) && normalizeCompareCode(getItemName(item)) === normalizeCompareCode(code));
    if (existing) {
      targetCid = String(existing.cid || existing.fid || existing.file_id || '');
    } else {
      const result = await createFolder(cid, code);
      targetCid = String(result?.cid || result?.file_id || '');
    }

    if (!targetCid) continue;
    const moveResult = await moveFile(getItemId(video), targetCid);
    if (apiOperationSucceeded(moveResult)) organizedCount += 1;
  }

  return organizedCount;
}

async function processTask(task) {
  const config = await getConfigSnapshot();
  const autoDelete = config.push115_auto_delete_small === true;
  const autoOrganize = config.push115_auto_organize === true;
  const cleanupRules = buildCleanupRules(config);
  if (!autoDelete && !autoOrganize) {
    task.status = 'recorded';
    task.message = '已记录任务；自动处理未开启';
    task.updatedAt = Date.now();
    appendTaskLog(task, task.message);
    return;
  }

  if (Date.now() - (task.createdAt || Date.now()) > TASK_MAX_AGE_MS) {
    task.status = 'failed';
    task.message = '任务等待超过 7 天，已停止自动监控';
    task.lastError = task.message;
    task.updatedAt = Date.now();
    appendTaskLog(task, task.message);
    return;
  }

  task.attempts = Number(task.attempts || 0) + 1;
  const remoteTasks = await getOfflineTasks();
  const remoteTask = remoteTasks.find(item => remoteTaskMatches(item, task));
  if (!remoteTask) {
    task.status = 'waiting';
    task.message = `等待 115 任务出现（第 ${task.attempts} 次检查）`;
    task.updatedAt = Date.now();
    if (task.attempts === 1 || task.attempts % 10 === 0) appendTaskLog(task, task.message);
    return;
  }

  task.remoteName = String(remoteTask.name || task.remoteName || '').trim();
  task.remoteId = getRemoteTaskId(remoteTask) || task.remoteId;
  const percent = Number(remoteTask.percentDone);
  const remoteStatus = Number(remoteTask.status);
  const remoteState = Number(remoteTask.state);
  const isCompleted = remoteStatus === 2 || percent === 100 || remoteState === 1;
  if (remoteStatus === -1 || remoteState === 2) {
    task.status = 'failed';
    task.message = `115 离线任务失败：${remoteTask.error_msg || '未知错误'}`;
    task.lastError = task.message;
    task.updatedAt = Date.now();
    appendTaskLog(task, task.message);
    return;
  }
  if (!isCompleted) {
    task.status = 'processing';
    task.percent = Number.isFinite(percent) ? percent : null;
    task.message = Number.isFinite(percent) ? `115 离线下载中（${percent}%）` : '115 离线下载处理中';
    task.updatedAt = Date.now();
    if (task.attempts === 1 || task.attempts % 5 === 0) appendTaskLog(task, task.message);
    return;
  }

  let folderCid = String(task.remoteFolderCid || '').trim();
  let folderResolved = false;
  if (!folderCid) folderCid = getRemoteTaskFolderCid(remoteTask);
  if (folderCid) {
    const usable = await ensureUsableCid(folderCid);
    if (usable) {
      folderCid = usable;
      folderResolved = true;
    }
  }
  if (!folderResolved) {
    const found = await resolveTaskFolder(task.savePathCid, task.remoteName);
    if (found?.cid) {
      folderCid = found.cid;
      task.folderName = found.name;
      folderResolved = Boolean(await ensureUsableCid(folderCid));
    }
  }

  const targetCid = folderCid || (await ensureUsableCid(task.savePathCid));
  if (!targetCid) throw new Error('未找到下载完成后的 115 目录');

  task.status = 'processing';
  task.remoteFolderCid = folderResolved ? targetCid : '';
  task.updatedAt = Date.now();
  appendTaskLog(task, '离线下载完成，开始安全整理');

  const actionMessages = [];
  if (autoDelete) {
    const threshold = Number(config.push115_delete_size_threshold) || 100;
    const result = await cleanSmallFiles(targetCid, threshold, cleanupRules);
    if (result.count > 0) actionMessages.push(`回收 ${result.count} 个明确垃圾文件`);
    appendTaskLog(task, `安全扫描 ${result.scannedFolders} 个目录，回收 ${result.count} 个文件`);
    for (const file of result.files.slice(0, 40)) {
      appendTaskLog(task, `回收：${file.name}（${file.reason}）`);
    }
  }

  if (autoOrganize) {
    if (task.code && folderResolved) {
      const result = await organizeKnownTaskFolder(targetCid, task);
      if (result.main) actionMessages.push(`主视频 → ${result.main}`);
      if (result.subtitles > 0) actionMessages.push(`整理 ${result.subtitles} 个字幕`);
      if (result.folderRenamed) actionMessages.push(`文件夹 → ${task.code}`);
      appendTaskLog(task, `按 ${task.code} 整理完成`);
    } else if (!task.code) {
      const count = await organizeVideos(targetCid);
      if (count > 0) actionMessages.push(`整理 ${count} 个视频`);
      appendTaskLog(task, `未取得页面番号，按文件名整理 ${count} 个视频`);
    } else {
      appendTaskLog(task, `已记录番号 ${task.code}，但未定位到独立任务文件夹；为避免误动其他任务，本次未移动文件`);
    }
  }

  task.status = 'completed';
  task.completedAt = Date.now();
  task.message = actionMessages.length > 0 ? actionMessages.join('，') : '处理完成，未发现需要修改的文件';
  task.updatedAt = Date.now();
  appendTaskLog(task, task.message);
  notifyTask(task, '115 离线助手处理完成', task.message);
}

async function processPendingTasks() {
  if (taskMonitorRunning) return;
  taskMonitorRunning = true;
  try {
    const tasks = await readTaskRecords();
    for (const task of tasks.filter(taskIsActive)) {
      try {
        await processTask(task);
      } catch (error) {
        task.status = 'waiting';
        task.lastError = error?.message || String(error);
        task.message = `后台处理遇到波动，将稍后重试：${task.lastError}`;
        task.updatedAt = Date.now();
        if (task.attempts === 0 || task.attempts % 5 === 0) appendTaskLog(task, task.message);
      }
      await persistTask(task);
    }
  } finally {
    taskMonitorRunning = false;
  }
}

// ========== Notifications ==========

function notifyTask(task, title, message) {
  if (!chrome.notifications?.create) return;
  chrome.notifications.create(`push115-${task.taskId}-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

function handleNotify(request) {
  const { title, message } = request.details || {};
  if (!chrome.notifications?.create) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title || '115 Offline Helper',
    message: message || '',
  });
}
