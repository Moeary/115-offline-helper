// Full settings and background log page for 115 Offline Helper.

const CONFIG_KEYS = {
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
}

const DEFAULT_CONFIG = {
	[CONFIG_KEYS.SAVE_PATH]: '',
	[CONFIG_KEYS.SAVE_PATH_CID]: '0',
	[CONFIG_KEYS.SAVE_PATH_LIST]: '',
	[CONFIG_KEYS.AUTO_DELETE_SMALL]: false,
	[CONFIG_KEYS.DELETE_SIZE_THRESHOLD]: 100,
	[CONFIG_KEYS.AUTO_ORGANIZE]: false,
	[CONFIG_KEYS.AUTO_DETECT]: false,
	[CONFIG_KEYS.I18N_LOCALE]: 'zh-CN',
	[CONFIG_KEYS.THEME]: 'auto',
	[CONFIG_KEYS.JUNK_EXTENSIONS]: '.url, .html, .htm, .txt, .exe, .bat, .cmd, .torrent',
	[CONFIG_KEYS.PRESERVE_EXTENSIONS]: '.srt, .ass, .ssa, .sup, .vtt',
	[CONFIG_KEYS.CLEAN_EXTENSIONS]: '',
	[CONFIG_KEYS.CLEAN_IMAGES]: false,
	[CONFIG_KEYS.CLEAN_NFO]: false,
}

const I18N_STRINGS = {
	'zh-CN': {
		page_title: '115离线助手设置',
		page_subtitle: '规则、任务与日志集中管理',
		settings_title: '设置',
		settings_subtitle: '这些设置会被后台任务和网页推送共同使用。',
		language_label: '语言 / Language',
		theme_label: '主题 / Theme',
		theme_auto: '跟随系统',
		theme_light: '浅色',
		theme_dark: '深色',
		save_cid_label: '默认保存目录',
		save_cid_hint: '目录选项来自“115 离线目录”列表；未配置时使用根目录。',
		threshold_label: '小视频阈值（MB）',
		threshold_hint: '阈值只用于筛选；主视频、CD/Disc/Part 分片不会因体积小而删除。',
		save_dirs_label: '115 离线目录（一行一个）',
		save_dirs_placeholder: '例如：电影:123456789',
		save_dirs_hint: '格式：目录名:CID，例如：电影:123456789。',
		auto_delete_label: '安全清理广告/垃圾文件',
		auto_delete_hint: '只处理明确命中的扩展名或小广告视频。',
		auto_organize_label: '自动整理视频文件',
		auto_organize_hint: '优先使用页面番号整理任务文件夹、主视频和字幕。',
		auto_detect_label: '自动识别链接',
		auto_detect_hint: '在所有网页检测 magnet/ed2k，需要额外页面权限。',
		rules_title: '文件扩展名规则',
		rules_subtitle: '每行或用逗号分隔；扩展名可带或不带点。',
		junk_extensions_label: '明确垃圾扩展名（直接回收）',
		junk_extensions_placeholder: '.url\n.html\n.htm\n.txt',
		junk_extensions_hint: '默认包含 .html、.htm、.txt 等下载附带文件；移除某项即可保留该类型。',
		preserve_extensions_label: '保护扩展名（永不自动清理）',
		preserve_extensions_placeholder: '.srt\n.ass\n.ssa\n.sup\n.vtt',
		preserve_extensions_hint: '字幕默认在这里；若同一扩展名同时出现，保护规则优先。',
		clean_extensions_label: '可选清理扩展名（仅小于阈值）',
		clean_extensions_placeholder: '例如：.bak\n.tmp',
		clean_extensions_hint: '默认为空。适合放入你确认无用的非视频扩展名；不会替代视频安全判断。',
		clean_images_label: '清理图片/海报',
		clean_images_hint: '默认关闭；开启后，小于阈值的常见图片会进入回收候选。',
		clean_nfo_label: '清理 NFO',
		clean_nfo_hint: '默认关闭；开启后，小于阈值的 .nfo 会进入回收候选。',
		save_button: '保存设置',
		reset_button: '恢复默认',
		save_success: '设置已保存。',
		save_failed: '设置保存失败：',
		permission_denied: '未获得网页权限，自动识别链接仍保持关闭。',
		confirm_reset: '确定将本页设置恢复为默认值吗？',
		logs_title: '后台任务与日志',
		logs_subtitle: '这里会保留最近任务的处理状态、错误和清理明细。',
		clear_logs_button: '清空日志',
		confirm_clear_logs: '确定清空已完成、失败和已记录的历史日志吗？等待中或处理中的任务会保留。',
		clear_logs_success: '日志已清空，保留 {count} 个进行中的任务。',
		clear_logs_failed: '清空日志失败：',
		complete_reset_button: '完全重置任务',
		confirm_complete_reset: '确定完全重置扩展本地任务吗？这会清除全部任务记录、处理计划、Mikan 番组绑定和去重回执；不会取消 115 云端任务，也不会修改登录信息、目录或站点设置。',
		complete_reset_success: '已清除本地任务 {tasks} 条、番组绑定 {series} 个。115 云端任务未受影响。',
		complete_reset_failed: '完全重置失败：',
		refresh_button: '刷新',
		logs_empty: '暂无后台任务日志',
		logs_summary: '共 {count} 条任务记录',
		logs_label: '处理日志',
		task_meta_empty: '暂无附加信息',
		task_status_waiting: '等待 115 任务',
		task_status_processing: '处理中',
		task_status_recorded: '已记录',
		task_status_completed: '已完成',
		task_status_failed: '失败',
		task_retry: '重试',
		task_retry_failed: '重试失败：',
		refresh_failed: '读取日志失败：',
	},
	'en-US': {
		page_title: '115 Offline Helper Settings',
		page_subtitle: 'Manage rules, tasks, and logs in one place',
		settings_title: 'Settings',
		settings_subtitle: 'These settings are shared by background tasks and link submission.',
		language_label: 'Language',
		theme_label: 'Theme',
		theme_auto: 'System',
		theme_light: 'Light',
		theme_dark: 'Dark',
		save_cid_label: 'Default save directory',
		save_cid_hint: 'Options come from the 115 offline directory list; the root is used when none is configured.',
		threshold_label: 'Small-video threshold (MB)',
		threshold_hint: 'This only filters candidates; the main video and CD/Disc/Part files are protected.',
		save_dirs_label: '115 offline directories (one per line)',
		save_dirs_placeholder: 'e.g. Movies:123456789',
		save_dirs_hint: 'Format: Name:CID, e.g. Movies:123456789.',
		auto_delete_label: 'Safely clean junk/advertising files',
		auto_delete_hint: 'Only explicit extensions or short advertising videos are handled.',
		auto_organize_label: 'Auto organize video files',
		auto_organize_hint: 'Prefer the page code for the task folder, main video, and subtitles.',
		auto_detect_label: 'Auto detect links',
		auto_detect_hint: 'Detect magnet/ed2k on all pages; extra page permission is required.',
		rules_title: 'File extension rules',
		rules_subtitle: 'Separate entries with new lines or commas; the leading dot is optional.',
		junk_extensions_label: 'Explicit junk extensions (move to recycle bin)',
		junk_extensions_placeholder: '.url\n.html\n.htm\n.txt',
		junk_extensions_hint: 'Defaults include .html, .htm, and .txt; remove an entry to keep that type.',
		preserve_extensions_label: 'Protected extensions (never auto-clean)',
		preserve_extensions_placeholder: '.srt\n.ass\n.ssa\n.sup\n.vtt',
		preserve_extensions_hint: 'Subtitles are protected by default; protection wins if lists overlap.',
		clean_extensions_label: 'Optional cleanup extensions (below threshold only)',
		clean_extensions_placeholder: 'e.g. .bak\n.tmp',
		clean_extensions_hint: 'Empty by default. Use only for confirmed non-video junk; video safety rules remain active.',
		clean_images_label: 'Clean images/posters',
		clean_images_hint: 'Off by default; when enabled, common images below the threshold become candidates.',
		clean_nfo_label: 'Clean NFO files',
		clean_nfo_hint: 'Off by default; when enabled, .nfo files below the threshold become candidates.',
		save_button: 'Save settings',
		reset_button: 'Reset defaults',
		save_success: 'Settings saved.',
		save_failed: 'Failed to save settings: ',
		permission_denied: 'Page permission was not granted; auto detection remains off.',
		confirm_reset: 'Reset all settings on this page to their defaults?',
		logs_title: 'Background tasks and logs',
		logs_subtitle: 'Recent task states, errors, and cleanup details are shown here.',
		clear_logs_button: 'Clear logs',
		confirm_clear_logs: 'Clear completed, failed, and recorded history logs? Waiting or processing tasks will be kept.',
		clear_logs_success: 'Logs cleared; {count} active task(s) retained.',
		clear_logs_failed: 'Failed to clear logs: ',
		complete_reset_button: 'Complete task reset',
		confirm_complete_reset: 'Reset all local extension task state? This clears task records, processing plans, Mikan series bindings, and dedupe receipts. It does not cancel 115 cloud tasks or change login, directories, or site settings.',
		complete_reset_success: 'Cleared {tasks} local task(s) and {series} series binding(s). 115 cloud tasks were not changed.',
		complete_reset_failed: 'Complete reset failed: ',
		refresh_button: 'Refresh',
		logs_empty: 'No background task logs yet',
		logs_summary: '{count} task records',
		logs_label: 'Processing log',
		task_meta_empty: 'No extra information',
		task_status_waiting: 'Waiting for 115',
		task_status_processing: 'Processing',
		task_status_recorded: 'Recorded',
		task_status_completed: 'Completed',
		task_status_failed: 'Failed',
		task_retry: 'Retry',
		task_retry_failed: 'Retry failed: ',
		refresh_failed: 'Failed to read logs: ',
	},
}

let configCache = { ...DEFAULT_CONFIG }

function t(key) {
	const locale = configCache[CONFIG_KEYS.I18N_LOCALE] || 'zh-CN'
	const strings = I18N_STRINGS[locale] || I18N_STRINGS['zh-CN']
	return strings[key] || key
}

function replaceCount(text, count) {
	return String(text || '').replace('{count}', String(count))
}

function sendMessage(action, details = {}) {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({ action, details }, response => {
			if (chrome.runtime.lastError) {
				reject(chrome.runtime.lastError)
			} else if (response && response.success) {
				resolve(response)
			} else {
				reject(new Error(response?.error || 'Unknown error'))
			}
		})
	})
}

function normalizeCid(value) {
	const text = String(value ?? '').trim()
	return /^\d+$/.test(text) ? text : '0'
}

function normalizeExtensionText(value) {
	const values = String(value ?? '').split(/[\s,，、;；]+/)
	return [...new Set(
		values
			.map(item => item.trim().toLowerCase())
			.map(item => (item && item.startsWith('.') ? item : item ? `.${item}` : ''))
			.filter(item => /^\.[a-z0-9][a-z0-9+_-]*$/i.test(item)),
	)].join('\n')
}

function getConfig(key) {
	return configCache[key]
}

function applyTheme(theme) {
	document.body.classList.remove('dark-theme')
	if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
		document.body.classList.add('dark-theme')
	}
}

function applyLocale() {
	document.documentElement.lang = getConfig(CONFIG_KEYS.I18N_LOCALE) || 'zh-CN'
	document.title = t('page_title')
	document.querySelectorAll('[data-i18n]').forEach(element => {
		element.textContent = t(element.dataset.i18n)
	})
	document.querySelectorAll('[data-placeholder]').forEach(element => {
		element.placeholder = t(element.dataset.placeholder)
	})
}

function renderSavePathSelectors(preserveSiteProfiles = false, selectedCidOverride = undefined) {
	const listText = document.getElementById('push115-save-dirs-input')?.value || ''
	const rootLabel = getConfig(CONFIG_KEYS.I18N_LOCALE) === 'en-US' ? 'Root' : '根目录'
	const select = document.getElementById('push115-default-save-cid')
	if (select && window.Push115?.PathUtils) {
		const selectedCid = Push115.PathUtils.normalizeCid(
			selectedCidOverride ?? select.value ?? getConfig(CONFIG_KEYS.SAVE_PATH_CID),
		) || '0'
		const options = Push115.PathUtils.buildPathOptions(listText, rootLabel)
		if (!options.some(item => item.cid === selectedCid)) options.push({ name: '', cid: selectedCid })
		select.textContent = ''
		for (const item of options) {
			const option = document.createElement('option')
			option.value = item.cid
			option.textContent = Push115.PathUtils.formatPathLabel(item, rootLabel)
			option.selected = item.cid === selectedCid
			select.appendChild(option)
		}
	}
	if (preserveSiteProfiles) {
		const profiles = Push115.OptionsSiteProfiles.collect()
		Push115.OptionsSiteProfiles.render(profiles, listText, rootLabel)
	} else {
		Push115.OptionsSiteProfiles.render(getConfig(CONFIG_KEYS.SITE_PROFILES), listText, rootLabel)
	}
}

function fillForm() {
	document.getElementById('push115-language-select').value = getConfig(CONFIG_KEYS.I18N_LOCALE)
	document.getElementById('push115-theme-select').value = getConfig(CONFIG_KEYS.THEME)
	document.getElementById('push115-delete-size').value = getConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD)
	document.getElementById('push115-save-dirs-input').value = getConfig(CONFIG_KEYS.SAVE_PATH_LIST)
	document.getElementById('push115-auto-delete').checked = getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL) === true
	document.getElementById('push115-auto-organize').checked = getConfig(CONFIG_KEYS.AUTO_ORGANIZE) === true
	const autoDetect = document.getElementById('push115-auto-detect')
	if (autoDetect) autoDetect.checked = getConfig(CONFIG_KEYS.AUTO_DETECT) === true
	document.getElementById('push115-junk-extensions').value = getConfig(CONFIG_KEYS.JUNK_EXTENSIONS)
	document.getElementById('push115-preserve-extensions').value = getConfig(CONFIG_KEYS.PRESERVE_EXTENSIONS)
	document.getElementById('push115-clean-extensions').value = getConfig(CONFIG_KEYS.CLEAN_EXTENSIONS)
	document.getElementById('push115-clean-images').checked = getConfig(CONFIG_KEYS.CLEAN_IMAGES) === true
	document.getElementById('push115-clean-nfo').checked = getConfig(CONFIG_KEYS.CLEAN_NFO) === true
	renderSavePathSelectors(false, getConfig(CONFIG_KEYS.SAVE_PATH_CID))
}

function collectFormConfig() {
	const threshold = Number(document.getElementById('push115-delete-size').value)
	const siteProfiles = Push115.OptionsSiteProfiles.collect()
	return {
		[CONFIG_KEYS.SAVE_PATH]: getConfig(CONFIG_KEYS.SAVE_PATH) || '',
		[CONFIG_KEYS.SAVE_PATH_CID]: normalizeCid(document.getElementById('push115-default-save-cid').value),
		[CONFIG_KEYS.SAVE_PATH_LIST]: document.getElementById('push115-save-dirs-input').value.trim(),
		[CONFIG_KEYS.AUTO_DELETE_SMALL]: document.getElementById('push115-auto-delete').checked,
		[CONFIG_KEYS.DELETE_SIZE_THRESHOLD]: Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold) : 100,
		[CONFIG_KEYS.AUTO_ORGANIZE]: document.getElementById('push115-auto-organize').checked,
		[CONFIG_KEYS.AUTO_DETECT]: siteProfiles.generic.enabled,
		[CONFIG_KEYS.I18N_LOCALE]: document.getElementById('push115-language-select').value || 'zh-CN',
		[CONFIG_KEYS.THEME]: document.getElementById('push115-theme-select').value || 'auto',
		[CONFIG_KEYS.JUNK_EXTENSIONS]: normalizeExtensionText(document.getElementById('push115-junk-extensions').value),
		[CONFIG_KEYS.PRESERVE_EXTENSIONS]: normalizeExtensionText(document.getElementById('push115-preserve-extensions').value),
		[CONFIG_KEYS.CLEAN_EXTENSIONS]: normalizeExtensionText(document.getElementById('push115-clean-extensions').value),
		[CONFIG_KEYS.CLEAN_IMAGES]: document.getElementById('push115-clean-images').checked,
		[CONFIG_KEYS.CLEAN_NFO]: document.getElementById('push115-clean-nfo').checked,
		[CONFIG_KEYS.SITE_PROFILES]: siteProfiles,
	}
}

function showSettingsStatus(type, message) {
	const area = document.getElementById('push115-settings-status')
	area.className = `push115-status ${type || ''}`
	area.textContent = message || ''
}

async function requestContentScriptPermissions(siteProfiles) {
	for (const [siteId, definition] of Object.entries(Push115.Config.SITE_DEFINITIONS)) {
		if (!siteProfiles[siteId]?.enabled) continue
		const origins = [...definition.matches]
		let granted = await chrome.permissions.contains({ origins })
		if (!granted) granted = await chrome.permissions.request({ origins })
		if (!granted) throw new Error(`${definition.label}: ${t('permission_denied')}`)
	}
}

async function saveSettings(event) {
	event.preventDefault()
	const button = document.getElementById('push115-save-settings')
	button.disabled = true
	try {
		// The directory textarea may still be focused when the form is submitted.
		// Rebuild the selects once so a newly entered Name:CID line is available to
		// both the global default and every site profile before collecting values.
		renderSavePathSelectors(true)
		const nextConfig = collectFormConfig()
		await requestContentScriptPermissions(nextConfig[CONFIG_KEYS.SITE_PROFILES])
		await chrome.storage.local.set(nextConfig)
		await sendMessage('SYNC_CONTENT_SCRIPTS')
		configCache = { ...configCache, ...nextConfig }
		applyTheme(getConfig(CONFIG_KEYS.THEME))
		applyLocale()
		fillForm()
		showSettingsStatus('success', t('save_success'))
	} catch (error) {
		showSettingsStatus('error', t('save_failed') + (error?.message || error))
	} finally {
		button.disabled = false
	}
}

async function resetSettings() {
	if (!window.confirm(t('confirm_reset'))) return
	const button = document.getElementById('push115-reset-settings')
	button.disabled = true
	try {
		const resetConfig = {
			...DEFAULT_CONFIG,
			[CONFIG_KEYS.SITE_PROFILES]: Push115.Config.normalizeSiteProfiles({}, DEFAULT_CONFIG),
		}
		await chrome.storage.local.set(resetConfig)
		await sendMessage('SYNC_CONTENT_SCRIPTS')
		configCache = { ...configCache, ...resetConfig }
		applyTheme(getConfig(CONFIG_KEYS.THEME))
		applyLocale()
		fillForm()
		showSettingsStatus('success', t('save_success'))
	} catch (error) {
		showSettingsStatus('error', t('save_failed') + (error?.message || error))
	} finally {
		button.disabled = false
	}
}

function bindEvents() {
	document.getElementById('push115-settings-form').addEventListener('submit', saveSettings)
	document.getElementById('push115-reset-settings').addEventListener('click', resetSettings)
	document.getElementById('push115-save-dirs-input').addEventListener('change', () => renderSavePathSelectors(true))
	document.getElementById('push115-refresh-logs').addEventListener('click', Push115.OptionsTasks.refresh)
	document.getElementById('push115-clear-logs').addEventListener('click', Push115.OptionsTasks.clearLogs)
	document.getElementById('push115-complete-reset').addEventListener('click', Push115.OptionsTasks.completeReset)
	document.getElementById('push115-language-select').addEventListener('change', event => {
		configCache[CONFIG_KEYS.I18N_LOCALE] = event.target.value
		applyLocale()
	})
	document.getElementById('push115-theme-select').addEventListener('change', event => {
		configCache[CONFIG_KEYS.THEME] = event.target.value
		applyTheme(event.target.value)
	})

	chrome.runtime.onMessage.addListener(request => {
		if (request?.action === 'TASK_UPDATED') void Push115.OptionsTasks.refresh()
	})

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local') return
		let changed = false
		for (const key of Object.values(CONFIG_KEYS)) {
			if (!Object.prototype.hasOwnProperty.call(changes, key)) continue
			configCache[key] = changes[key].newValue === undefined ? DEFAULT_CONFIG[key] : changes[key].newValue
			changed = true
		}
		if (changed) {
			applyTheme(getConfig(CONFIG_KEYS.THEME))
			applyLocale()
			fillForm()
		}
	})
}

async function init() {
	const items = await chrome.storage.local.get(DEFAULT_CONFIG)
	configCache = { ...DEFAULT_CONFIG, ...items }
	configCache[CONFIG_KEYS.SITE_PROFILES] = Push115.Config.normalizeSiteProfiles(
		items[CONFIG_KEYS.SITE_PROFILES],
		configCache,
	)
	applyTheme(getConfig(CONFIG_KEYS.THEME))
	applyLocale()
	fillForm()
	bindEvents()
	await Push115.OptionsTasks.refresh()
	setInterval(Push115.OptionsTasks.refresh, 5000)
}

void init()
