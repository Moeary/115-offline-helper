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
		BRIDGE_ENABLED: 'push115_bridge_enabled',
		BRIDGE_TOKEN: 'push115_bridge_token',
		BRIDGE_PAIRED: 'push115_bridge_paired',
		// Keep the historical key for migration; it stores the Bridge default CID.
		BRIDGE_TARGET_CID: 'push115_bridge_target_cid',
		BRIDGE_JOBS: 'push115_bridge_jobs',
		BRIDGE_OUTBOX: 'push115_bridge_outbox',
		BRIDGE_ACTIONS: 'push115_bridge_actions',
		BRIDGE_ACTION_OUTBOX: 'push115_bridge_action_outbox',
		DIRECTORY_INDEX: 'push115_directory_index',
	})

	// The bridge deliberately has one fixed loopback endpoint.  Keeping this
	// value in shared configuration lets the options page explain and request
	// exactly the permission used by the service worker without exposing a free
	// form URL setting.
	const BRIDGE_BASE_URL = 'http://127.0.0.1:52115'
	const BRIDGE_ORIGIN = 'http://127.0.0.1:52115'
	const BRIDGE_BOOTSTRAP_STATUS_PATH = '/bootstrap/status'
	const BRIDGE_BOOTSTRAP_CONNECT_PATH = '/bootstrap/connect'
	const BRIDGE_BOOTSTRAP_PAIR_PATH = '/bootstrap/pair'
	const BRIDGE_TELEGRAM_RUNTIME_PATH = '/v1/runtime/telegram'
	// Chrome match patterns are host based; the transport itself still checks
	// the fixed :52115 origin before every request.
	const BRIDGE_HOST_PERMISSION = 'http://127.0.0.1/*'

	const MIKAN_HOSTNAMES = Object.freeze([
		'mikan.congvps.icu',
		'mikanani.me',
		'mikanime.tv',
		'mikanani.kas.pub',
		'mikan.tangbai.cc',
	])
	const MIKAN_MATCHES = Object.freeze(MIKAN_HOSTNAMES.map(hostname => `*://${hostname}/*`))
	function isMikanHostname(hostname) {
		return MIKAN_HOSTNAMES.includes(String(hostname || '').toLowerCase())
	}
	const SOUTHPLUS_HOSTNAMES = Object.freeze([
		'south-plus.net',
		'www.south-plus.net',
	])
	const SOUTHPLUS_MATCHES = Object.freeze(SOUTHPLUS_HOSTNAMES.map(hostname => `*://${hostname}/*`))
	function isSouthPlusHostname(hostname) {
		return SOUTHPLUS_HOSTNAMES.includes(String(hostname || '').toLowerCase())
	}

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
			matches: MIKAN_MATCHES,
			mediaType: 'anime',
		}),
		southplus: Object.freeze({
			label: 'South Plus',
			matches: SOUTHPLUS_MATCHES,
			mediaType: 'jav',
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
		southplus: Object.freeze({
			enabled: true,
			defaultSavePathCid: '0',
			defaultProcessorProfile: 'jav',
			inlineSendButton: true,
			recordButton: true,
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
		[STORAGE_KEYS.BRIDGE_ENABLED]: false,
		[STORAGE_KEYS.BRIDGE_TOKEN]: '',
		[STORAGE_KEYS.BRIDGE_PAIRED]: false,
		[STORAGE_KEYS.BRIDGE_TARGET_CID]: '0',
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
			if (siteId === 'southplus') profile.recordButton = saved.recordButton !== undefined
				? saved.recordButton === true
				: true
			if (['nyaa', 'sukebei', 'mikan', 'southplus'].includes(siteId)) {
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

	const PUBLIC_CONFIG_KEYS = Object.freeze([...new Set([
		...Object.keys(DEFAULT_CONFIG),
		STORAGE_KEYS.SITE_PROFILES,
	])].filter(key => ![
		STORAGE_KEYS.BRIDGE_ENABLED,
		STORAGE_KEYS.BRIDGE_TOKEN,
		STORAGE_KEYS.BRIDGE_PAIRED,
		STORAGE_KEYS.BRIDGE_TARGET_CID,
		STORAGE_KEYS.BRIDGE_JOBS,
		STORAGE_KEYS.BRIDGE_OUTBOX,
		STORAGE_KEYS.BRIDGE_ACTIONS,
		STORAGE_KEYS.BRIDGE_ACTION_OUTBOX,
	].includes(key)))

	async function loadConfig() {
		// Content scripts only need the public site/file settings.  In
		// particular, never use get(null) here: that would copy the local bridge
		// Bearer token into every content-script configuration object.
		const stored = await chrome.storage.local.get(PUBLIC_CONFIG_KEYS)
		const config = { ...DEFAULT_CONFIG, ...stored }
		for (const key of [
			STORAGE_KEYS.BRIDGE_ENABLED,
			STORAGE_KEYS.BRIDGE_TOKEN,
			STORAGE_KEYS.BRIDGE_PAIRED,
			STORAGE_KEYS.BRIDGE_TARGET_CID,
			STORAGE_KEYS.BRIDGE_JOBS,
			STORAGE_KEYS.BRIDGE_OUTBOX,
			STORAGE_KEYS.BRIDGE_ACTIONS,
			STORAGE_KEYS.BRIDGE_ACTION_OUTBOX,
		]) delete config[key]
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
		MIKAN_HOSTNAMES,
		MIKAN_MATCHES,
		isMikanHostname,
		SOUTHPLUS_HOSTNAMES,
		SOUTHPLUS_MATCHES,
		isSouthPlusHostname,
		SITE_DEFINITIONS,
		DEFAULT_SITE_PROFILES,
		PROCESSOR_PROFILES,
		BATCH_CONCURRENCY_MAX,
		PUBLIC_CONFIG_KEYS,
		BRIDGE_BASE_URL,
		BRIDGE_ORIGIN,
		BRIDGE_BOOTSTRAP_STATUS_PATH,
		BRIDGE_BOOTSTRAP_CONNECT_PATH,
		BRIDGE_BOOTSTRAP_PAIR_PATH,
		BRIDGE_TELEGRAM_RUNTIME_PATH,
		BRIDGE_HOST_PERMISSION,
		DEFAULT_CONFIG,
		normalizeCid,
		normalizeProcessorProfile,
		normalizeSiteProfiles,
		loadConfig,
		migrateConfig,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
