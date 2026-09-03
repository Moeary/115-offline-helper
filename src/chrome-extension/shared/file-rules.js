// Conservative file classification rules shared by the background processor.
// Files are kept unless a rule provides enough evidence that they are junk.

(function (global) {
  'use strict';

  const VIDEO_EXTENSIONS = Object.freeze([
    '.mp4',
    '.mkv',
    '.avi',
    '.wmv',
    '.mov',
    '.flv',
    '.rmvb',
    '.rm',
    '.ts',
    '.m2ts',
    '.webm',
    '.m4v',
    '.3gp',
    '.mpeg',
    '.mpg',
  ]);

  const DEFAULT_JUNK_EXTENSIONS = Object.freeze([
    '.url',
    '.html',
    '.htm',
    '.txt',
    '.exe',
    '.bat',
    '.cmd',
    '.torrent',
  ]);

  const DEFAULT_PRESERVE_EXTENSIONS = Object.freeze([
    '.srt',
    '.ass',
    '.ssa',
    '.sup',
    '.vtt',
  ]);

  const DEFAULT_CLEAN_EXTENSIONS = Object.freeze([]);

  const IMAGE_EXTENSIONS = Object.freeze([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.bmp',
    '.avif',
    '.tif',
    '.tiff',
  ]);

  const ALWAYS_DELETE_EXTENSIONS = DEFAULT_JUNK_EXTENSIONS;
  const PRESERVE_EXTENSIONS = DEFAULT_PRESERVE_EXTENSIONS;

  const STRONG_AD_KEYWORDS = Object.freeze([
    '最新地址发布',
    '最新地址',
    '永久地址',
    '二维码',
    '扫码',
    '宣传',
    '广告',
    '推广',
    '社区最新情报',
    '保证服务全球',
    '聚合全网',
    '服务全球',
  ]);

  const WEAK_AD_KEYWORDS = Object.freeze(['福利', '短片', '片段', '地址']);
  const SHORT_VIDEO_SECONDS = 10 * 60;

  function getFileName(item) {
    return String(item?.n || item?.name || '').trim();
  }

  function getExtension(name) {
    const match = String(name || '').toLowerCase().match(/\.[^.\\/]+$/);
    return match ? match[0] : '';
  }

  function normalizeExtensionList(raw) {
    const values = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,，、;；]+/);
    return [...new Set(
      values
        .map(value => String(value || '').trim().toLowerCase())
        .map(value => (value && value.startsWith('.') ? value : value ? `.${value}` : ''))
        .filter(value => /^\.[a-z0-9][a-z0-9+_-]*$/i.test(value)),
    )];
  }

  function toExtensionSet(values) {
    return new Set(normalizeExtensionList(values));
  }

  function getConfiguredValue(config, keys, fallback) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(config, key) && config[key] !== undefined && config[key] !== null) {
        return config[key];
      }
    }
    return fallback;
  }

  function buildRules(config = {}) {
    const junkExtensions = toExtensionSet(
      getConfiguredValue(config, ['junkExtensions', 'deleteExtensions'], DEFAULT_JUNK_EXTENSIONS),
    );
    const preserveExtensions = toExtensionSet(
      getConfiguredValue(config, ['preserveExtensions', 'protectedExtensions'], DEFAULT_PRESERVE_EXTENSIONS),
    );
    const cleanExtensions = toExtensionSet(
      getConfiguredValue(config, ['cleanExtensions', 'optionalCleanExtensions'], DEFAULT_CLEAN_EXTENSIONS),
    );

    if (config.cleanImages === true) IMAGE_EXTENSIONS.forEach(extension => cleanExtensions.add(extension));
    if (config.cleanNfo === true) cleanExtensions.add('.nfo');

    return {
      junkExtensions,
      preserveExtensions,
      cleanExtensions,
    };
  }

  function getSizeBytes(item) {
    const raw = item?.size ?? item?.s ?? item?.file_size ?? item?.fileSize ?? 0;
    const size = Number(raw);
    return Number.isFinite(size) && size > 0 ? size : 0;
  }

  function parseDuration(value, fieldName = '') {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'string' && value.includes(':')) {
      const parts = value.split(':').map(part => Number(part));
      if (parts.some(part => !Number.isFinite(part) || part < 0) || parts.length > 3) return null;
      return parts.reduce((total, part) => total * 60 + part, 0);
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    if (/ms|millisecond/i.test(fieldName)) return parsed / 1000;
    return parsed;
  }

  function getDurationSeconds(item) {
    const fields = [
      'duration',
      'duration_seconds',
      'durationSeconds',
      'play_long',
      'playLong',
      'seconds',
      'duration_ms',
      'durationMs',
    ];

    for (const field of fields) {
      if (item?.[field] === undefined || item?.[field] === null) continue;
      const value = parseDuration(item[field], field);
      if (value !== null) return value;
    }
    return null;
  }

  function isVideo(item) {
    return VIDEO_EXTENSIONS.includes(getExtension(getFileName(item)));
  }

  function isPreserved(item, rules = null) {
    const extension = getExtension(getFileName(item));
    const configuredRules = rules || buildRules();
    return configuredRules.preserveExtensions.has(extension);
  }

  function isExplicitJunk(item, rules = null) {
    const extension = getExtension(getFileName(item));
    const configuredRules = rules || buildRules();
    return configuredRules.junkExtensions.has(extension);
  }

  function isMultipartName(name) {
    return /(?:^|[-_.\s])(?:cd|disc|disk|part)[-_.\s]?[12](?:$|[-_.\s])/i.test(String(name || ''));
  }

  function getAdKeywordScore(name) {
    const lowerName = String(name || '').toLowerCase();
    let score = 0;

    for (const keyword of STRONG_AD_KEYWORDS) {
      if (lowerName.includes(keyword.toLowerCase())) score += 2;
    }

    if (/(^|[\s._\-[\]()])(?:ad|ads|advert|promo|promotion)(?=$|[\s._\-[\]()])/i.test(lowerName)) {
      score += 2;
    }

    for (const keyword of WEAK_AD_KEYWORDS) {
      if (lowerName.includes(keyword.toLowerCase())) score += 1;
    }

    return score;
  }

  function fileIdKey(item) {
    const fid = item?.fid ?? item?.file_id ?? item?.fileId;
    return fid === undefined || fid === null ? '' : String(fid);
  }

  function getMainVideoIds(items) {
    const videos = (Array.isArray(items) ? items : []).filter(isVideo);
    const sizedVideos = videos.filter(item => getSizeBytes(item) > 0);
    if (sizedVideos.length === 0) return new Set();

    const largestSize = Math.max(...sizedVideos.map(getSizeBytes));
    const keepAtLeast = largestSize * 0.95;
    return new Set(
      sizedVideos
        .filter(item => getSizeBytes(item) >= keepAtLeast)
        .map(fileIdKey)
        .filter(Boolean),
    );
  }

  function keep(reason, extra = {}) {
    return { shouldDelete: false, reason, ...extra };
  }

  function remove(reason, extra = {}) {
    return { shouldDelete: true, reason, ...extra };
  }

  function getDeletionDecision(item, context = {}) {
    const name = getFileName(item);
    const extension = getExtension(name);
    const sizeBytes = getSizeBytes(item);
    const thresholdBytes = Number(context.thresholdBytes) || 0;
    const mainVideoIds = context.mainVideoIds instanceof Set ? context.mainVideoIds : new Set();
    const rules = context.rules || buildRules(context);
    const fid = fileIdKey(item);

    if (!fid) return keep('missing-id');
    if (isPreserved(item, rules)) return keep('protected-extension', { extension, sizeBytes });
    if (isExplicitJunk(item, rules)) return remove('explicit-junk-extension', { extension, sizeBytes });

    const keywordScore = getAdKeywordScore(name);
    if (!isVideo(item)) {
      if (rules.cleanExtensions.has(extension) && sizeBytes > 0 && sizeBytes < thresholdBytes) {
        return remove('configured-clean-extension', { extension, sizeBytes });
      }
      return keep('unknown-file-type', { extension, sizeBytes });
    }

    if (!thresholdBytes || !sizeBytes || sizeBytes >= thresholdBytes) {
      return keep('video-not-small', { extension, sizeBytes, keywordScore });
    }
    if (mainVideoIds.has(fid)) return keep('largest-video', { extension, sizeBytes, keywordScore });
    if (isMultipartName(name)) return keep('multipart-video', { extension, sizeBytes, keywordScore });

    const durationSeconds = getDurationSeconds(item);
    const isShortVideo = durationSeconds !== null && durationSeconds < SHORT_VIDEO_SECONDS;
    if (keywordScore >= 2) {
      return remove('advertisement-name', {
        extension,
        sizeBytes,
        keywordScore,
        durationSeconds,
      });
    }
    if (isShortVideo) {
      return remove('short-video', { extension, sizeBytes, durationSeconds, keywordScore });
    }

    return keep(durationSeconds === null ? 'unknown-duration' : 'video-not-short', {
      extension,
      sizeBytes,
      durationSeconds,
      keywordScore,
    });
  }

  function analyzeFiles(items, thresholdBytes, rules = null) {
    const files = (Array.isArray(items) ? items : []).filter(item => item && item.sha);
    const mainVideoIds = getMainVideoIds(files);
    return files.map(item => ({
      item,
      decision: getDeletionDecision(item, { thresholdBytes, mainVideoIds, rules: rules || buildRules() }),
    }));
  }

  const api = {
    VIDEO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    DEFAULT_JUNK_EXTENSIONS,
    DEFAULT_PRESERVE_EXTENSIONS,
    DEFAULT_CLEAN_EXTENSIONS,
    ALWAYS_DELETE_EXTENSIONS,
    PRESERVE_EXTENSIONS,
    SHORT_VIDEO_SECONDS,
    getFileName,
    getExtension,
    normalizeExtensionList,
    buildRules,
    getSizeBytes,
    getDurationSeconds,
    isVideo,
    isPreserved,
    isExplicitJunk,
    isMultipartName,
    getAdKeywordScore,
    getMainVideoIds,
    getDeletionDecision,
    analyzeFiles,
  };
  global.Push115 = global.Push115 || {};
  global.Push115.FileRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
