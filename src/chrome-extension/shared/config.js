;(function (global) {
	'use strict'

	const STORAGE_KEYS = Object.freeze({
		COOKIE: 'push115_cookie',
		SAVE_PATH: 'push115_save_path',
		SAVE_PATH_CID: 'push115_save_path_cid',
		SAVE_PATH_LIST: 'push115_save_path_list',
		AUTO_DELETE_SMALL: 'push115_auto_delete_small',
		DELETE_SIZE_THRESHOLD: 'push115_delete_size_threshold',
		AUTO_ORGANIZE: 'push115_auto_organize',
		AUTO_DETECT: 'push115_auto_detect',
		I18N_LOCALE: 'push115_i18n_locale',
		THEME: 'push115_theme',
		JUNK_EXTENSIONS: 'push115_junk_extensions',
		PRESERVE_EXTENSIONS: 'push115_preserve_extensions',
		CLEAN_EXTENSIONS: 'push115_clean_extensions',
		CLEAN_IMAGES: 'push115_clean_images',
		CLEAN_NFO: 'push115_clean_nfo',
		SITE_PROFILES: 'push115_site_profiles',
		TASKS: 'push115_tasks',
		TASK_MONITOR_CURSOR: 'push115_task_monitor_cursor',
		ANIME_LIBRARY: 'push115_anime_library',
	})

	const SITE_DEFINITIONS = Object.freeze({
		generic: Object.freeze({
			label: 'Generic',
			matches: Object.freeze(['<all_urls>']),
			mediaType: 'generic',
		}),
		javbus: Object.freeze({
			label: 'JavBus',
			matches: Object.freeze(['*://javbus.com/*', '*://*.javbus.com/*']),
			mediaType: 'jav',
		}),
		nyaa: Object.freeze({
			label: 'Nyaa',
			matches: Object.freeze(['*://nyaa.si/*']),
			mediaType: 'anime',
		}),
		sukebei: Object.freeze({
			label: 'Sukebei',
			matches: Object.freeze(['*://sukebei.nyaa.si/*']),
			mediaType: 'generic',
		}),
		mikan: Object.freeze({
			label: 'Mikan',
			matches: Object.freeze(['*://mikan.tangbai.cc/*']),
			mediaType: 'anime',
		}),
	})

	const DEFAULT_SITE_PROFILES = Object.freeze({
		generic: Object.freeze({ enabled: false, defaultSavePathCid: '0', defaultProcessorProfile: 'generic', inlineSendButton: true }),
		javbus: Object.freeze({ enabled: true, defaultSavePathCid: '0', defaultProcessorProfile: 'jav', inlineSendButton: true }),
		nyaa: Object.freeze({
			enabled: true,
			defaultSavePathCid: '0',
			defaultProcessorProfile: 'anime',
			inlineSendButton: true,
			batchSelection: true,
			batchConcurrency: 2,
		}),
		sukebei: Object.freeze({
			enabled: true,
			defaultSavePathCid: '0',
			defaultProcessorProfile: 'generic',
			inlineSendButton: true,
			batchSelection: true,
			batchConcurrency: 2,
		}),
		mikan: Object.freeze({
			enabled: true,
			defaultSavePathCid: '0',
			defaultProcessorProfile: 'anime',
			inlineSendButton: true,
			batchSelection: true,
			batchConcurrency: 2,
		}),
	})
	const PROCESSOR_PROFILES = Object.freeze(['generic', 'jav', 'anime'])
	// 115 对短时间内的批量请求较敏感。页面批量提交最多只允许两个
	// 离线任务同时进入后台；文件移动/重命名等远程变更另由 FilesApi 串行。
	const BATCH_CONCURRENCY_MAX = 2

	const DEFAULT_CONFIG = Object.freeze({
		[STORAGE_KEYS.SAVE_PATH]: '',
		[STORAGE_KEYS.SAVE_PATH_CID]: '0',
		[STORAGE_KEYS.SAVE_PATH_LIST]: '',
		[STORAGE_KEYS.AUTO_DELETE_SMALL]: false,
		[STORAGE_KEYS.DELETE_SIZE_THRESHOLD]: 100,
		[STORAGE_KEYS.AUTO_ORGANIZE]: false,
		[STORAGE_KEYS.AUTO_DETECT]: false,
		[STORAGE_KEYS.I18N_LOCALE]: 'zh-CN',
		[STORAGE_KEYS.THEME]: 'auto',
		[STORAGE_KEYS.JUNK_EXTENSIONS]: '.url, .html, .htm, .txt, .exe, .bat, .cmd, .torrent',
		[STORAGE_KEYS.PRESERVE_EXTENSIONS]: '.srt, .ass, .ssa, .sup, .vtt',
		[STORAGE_KEYS.CLEAN_EXTENSIONS]: '',
		[STORAGE_KEYS.CLEAN_IMAGES]: false,
		[STORAGE_KEYS.CLEAN_NFO]: false,
	})

	function normalizeCid(value, fallback = '0') {
		const cid = String(value ?? '').trim()
		return /^\d+$/.test(cid) ? cid : fallback
	}

	function normalizeProcessorProfile(value, fallback = 'generic') {
		const profile = String(value || '').trim().toLowerCase()
		if (PROCESSOR_PROFILES.includes(profile)) return profile
		// 1.1.0 used "default" for safe cleanup and "none" for Mikan.
		if (profile === 'default') return 'generic'
		if (profile === 'none') return fallback === 'anime' ? 'anime' : 'generic'
		return PROCESSOR_PROFILES.includes(fallback) ? fallback : 'generic'
	}

	function normalizeSiteProfiles(rawProfiles, legacyConfig = {}) {
		const raw = rawProfiles && typeof rawProfiles === 'object' ? rawProfiles : {}
		const defaultCid = normalizeCid(legacyConfig[STORAGE_KEYS.SAVE_PATH_CID], '0')
		const autoDetect = legacyConfig[STORAGE_KEYS.AUTO_DETECT] === true
		const autoOrganize = legacyConfig[STORAGE_KEYS.AUTO_ORGANIZE] === true
		const profiles = {}

		for (const [siteId, defaults] of Object.entries(DEFAULT_SITE_PROFILES)) {
			const saved = raw[siteId] && typeof raw[siteId] === 'object' ? raw[siteId] : {}
			const savedProcessor = saved.defaultProcessorProfile ?? saved.processorProfile
			const savedCid = saved.defaultSavePathCid ?? saved.savePathCid
			const migratedDefaults = {
				...defaults,
				defaultSavePathCid: defaultCid,
			}
			if (siteId === 'generic') {
				migratedDefaults.enabled = autoDetect
				migratedDefaults.defaultProcessorProfile = autoOrganize ? 'jav' : 'generic'
			}
			const profile = { ...migratedDefaults, ...saved }
			profile.enabled = profile.enabled === true
			profile.defaultSavePathCid = normalizeCid(savedCid ?? profile.defaultSavePathCid, defaultCid)
			profile.defaultProcessorProfile = normalizeProcessorProfile(
				savedProcessor ?? profile.defaultProcessorProfile,
				siteId === 'mikan' && savedProcessor === 'none' ? 'anime' : defaults.defaultProcessorProfile,
			)
			profile.inlineSendButton = saved.inlineSendButton !== undefined
				? saved.inlineSendButton === true
				: saved.enhancementMode !== 'modal'
			if (['nyaa', 'sukebei', 'mikan'].includes(siteId)) {
				profile.batchSelection = saved.batchSelection !== undefined ? saved.batchSelection === true : true
				const concurrency = Number(profile.batchConcurrency)
				profile.batchConcurrency = Number.isFinite(concurrency) ? Math.min(BATCH_CONCURRENCY_MAX, Math.max(1, Math.round(concurrency))) : 2
			}
			// Read-only compatibility aliases keep 1.1.0 callers and stored tasks usable during upgrade.
			profile.savePathCid = profile.defaultSavePathCid
			profile.processorProfile = profile.defaultProcessorProfile
			profiles[siteId] = profile
		}

		return profiles
	}

	async function loadConfig() {
		const stored = await chrome.storage.local.get(null)
		const config = { ...DEFAULT_CONFIG, ...stored }
		config[STORAGE_KEYS.SITE_PROFILES] = normalizeSiteProfiles(stored[STORAGE_KEYS.SITE_PROFILES], config)
		return config
	}

	async function migrateConfig() {
		const stored = await chrome.storage.local.get(null)
		const legacyConfig = { ...DEFAULT_CONFIG, ...stored }
		const profiles = normalizeSiteProfiles(stored[STORAGE_KEYS.SITE_PROFILES], legacyConfig)
		const tasks = Array.isArray(stored[STORAGE_KEYS.TASKS]) ? stored[STORAGE_KEYS.TASKS] : []
		let tasksChanged = false
		const migratedTasks = tasks.map(task => {
			const mediaType = task?.mediaType || (task?.code ? 'jav' : 'generic')
			const fallbackProfile = mediaType === 'anime' ? 'anime' : task?.code ? 'jav' : 'generic'
			const processorProfile = task?.processorProfile
				? normalizeProcessorProfile(task.processorProfile, fallbackProfile)
				: legacyConfig[STORAGE_KEYS.AUTO_ORGANIZE] === true ? 'jav' : fallbackProfile
			const migrated = {
				...task,
				url: task?.url || task?.magnet || '',
				sourceSite: task?.sourceSite || task?.source || 'generic',
				mediaType,
				metadata: task?.metadata && typeof task.metadata === 'object'
					? task.metadata
					: { migratedFromLegacyTask: true },
				// Old tasks used the global organize switch; preserve that behavior once during migration.
				processorProfile,
			}
			if (JSON.stringify(migrated) !== JSON.stringify(task)) tasksChanged = true
			return migrated
		})
		const updates = {}
		if (JSON.stringify(stored[STORAGE_KEYS.SITE_PROFILES] || {}) !== JSON.stringify(profiles)) {
			updates[STORAGE_KEYS.SITE_PROFILES] = profiles
		}
		if (tasksChanged) updates[STORAGE_KEYS.TASKS] = migratedTasks
		if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates)
		return { ...DEFAULT_CONFIG, ...stored, [STORAGE_KEYS.SITE_PROFILES]: profiles }
	}

	global.Push115 = global.Push115 || {}
	global.Push115.Config = {
		STORAGE_KEYS,
		SITE_DEFINITIONS,
		DEFAULT_SITE_PROFILES,
		PROCESSOR_PROFILES,
		BATCH_CONCURRENCY_MAX,
		DEFAULT_CONFIG,
		normalizeCid,
		normalizeProcessorProfile,
		normalizeSiteProfiles,
		loadConfig,
		migrateConfig,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
