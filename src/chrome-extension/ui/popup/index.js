// Popup Script for 115 Offline Helper

// Config Keys
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
		panel_title: '115离线助手',
		manual_download_label: '手动添加 Magnet / ED2K',
		manual_download_placeholder: '每行一个 magnet: 或 ed2k:',
		manual_download_continue: '继续确认',
		quick_add_title: '快速添加任务',
		quick_add_hint: '粘贴链接后继续确认，站点规则和处理方式可在高级设置中统一维护。',
		local_badge: '本地',
		recent_tasks_hint: '只展示最近几项，完整日志和失败重试在高级设置页。',
		quick_options_title: '快速选项',
		quick_options_hint: '常用选项即时保存；更多规则请打开高级设置。',
		safe_cleanup_hint: '仅处理明确安全的候选文件',
		preferences_title: '界面偏好',
		tab_home: '主页',
		tab_settings: '设置',
		save_path_label: '默认保存目录:',
		cid_hint: '提示: 在“设置”页维护目录列表（每行：目录名:CID）',
		root_path_name: '根目录',
		auto_delete_label: '安全清理广告文件',
		delete_size_label_pre: '小视频候选 <',
		delete_size_label_post: 'MB',
		delete_safe_hint: '仅回收明确垃圾；字幕默认保护，图片/海报与 NFO 清理默认关闭，视频还会避开主视频和 CD1/CD2。',
		auto_organize_label: '自动整理视频文件',
		organize_hint: '优先使用页面番号重命名任务文件夹、主视频和字幕',
		check_login_text: '检查状态',
		login_btn: '扫码登录',
		login_success: '115账号已登录',
		login_fail: '未登录，请先登录115',
		processing: '处理中...',
		background_tasks_label: '后台任务',
		no_background_tasks: '暂无后台任务',
		tab_tasks: '后台管理',
		open_task_manager: '后台管理',
		manage_tasks_hint: '查看任务状态、完整日志和失败重试。',
		refresh_tasks: '刷新',
		task_summary: '共 {count} 条任务记录',
		task_logs: '处理日志',
		open_options: '打开高级设置',
		open_options_hint: '在完整设置页管理扩展名规则、清理开关和目录。',
		task_status_waiting: '等待 115 任务',
		task_status_processing: '处理中',
		task_status_recorded: '已记录',
		task_status_completed: '已完成',
		task_status_failed: '失败',
		task_status_cancelled: '已取消（仅本地）',
		task_retry: '重试',
		settings_language_label: '语言 / Language',
		settings_theme_label: '主题 / Theme',
		theme_auto: '跟随系统',
		theme_light: '浅色',
		theme_dark: '深色',
		settings_save_dirs_label: '115 离线目录 (一行一个)',
		save_dirs_placeholder: '例如：98预处理:3280039214730565554',
		save_dirs_hint: '格式：目录名:CID，例如：电影:123456789',
		auto_detect_label: '自动识别链接',
		auto_detect_hint: '在所有网页上自动检测 magnet/ed2k 链接（需要额外权限）',
	},
	'en-US': {
		panel_title: '115 Offline Helper',
		manual_download_label: 'Add Magnet / ED2K manually',
		manual_download_placeholder: 'One magnet: or ed2k: link per line',
		manual_download_continue: 'Continue',
		quick_add_title: 'Quick add',
		quick_add_hint: 'Paste links and confirm; site rules and processing stay managed in Advanced settings.',
		local_badge: 'Local',
		recent_tasks_hint: 'Showing recent items; full logs and retry controls are in Advanced settings.',
		quick_options_title: 'Quick options',
		quick_options_hint: 'Common options save instantly; open Advanced settings for more rules.',
		safe_cleanup_hint: 'Only clearly safe candidates are processed',
		preferences_title: 'Interface preferences',
		tab_home: 'Home',
		tab_settings: 'Settings',
		save_path_label: 'Default Save Directory:',
		cid_hint: 'Tip: Maintain directory list in Settings, one per line: Name:CID',
		root_path_name: 'Root',
		auto_delete_label: 'Safe cleanup of junk files',
		delete_size_label_pre: 'Small-video candidate <',
		delete_size_label_post: 'MB',
		delete_safe_hint: 'Only clear junk is removed; subtitles are protected, image/NFO cleanup is off by default, and the main video/CD1/CD2 are kept.',
		auto_organize_label: 'Auto organize videos',
		organize_hint: 'Prefer the page code to rename the task folder, main video, and subtitles',
		check_login_text: 'Check Status',
		login_btn: 'QR Login',
		login_success: '115 is logged in',
		login_fail: 'Not logged in, please login first',
		processing: 'Processing...',
		background_tasks_label: 'Background tasks',
		no_background_tasks: 'No background tasks',
		tab_tasks: 'Task manager',
		open_task_manager: 'Task manager',
		manage_tasks_hint: 'View task states, full logs, and retry failed tasks.',
		refresh_tasks: 'Refresh',
		task_summary: '{count} task records',
		task_logs: 'Processing log',
		open_options: 'Open advanced settings',
		open_options_hint: 'Manage extension rules, cleanup switches, and directories in the full settings page.',
		task_status_waiting: 'Waiting for 115',
		task_status_processing: 'Processing',
		task_status_recorded: 'Recorded',
		task_status_completed: 'Completed',
		task_status_failed: 'Failed',
		task_status_cancelled: 'Cancelled (local only)',
		task_retry: 'Retry',
		settings_language_label: 'Language',
		settings_theme_label: 'Theme',
		theme_auto: 'System',
		theme_light: 'Light',
		theme_dark: 'Dark',
		settings_save_dirs_label: '115 Offline Directories (One per line)',
		save_dirs_placeholder: 'e.g., Preprocess:3280039214730565554',
		save_dirs_hint: 'Format: Name:CID, e.g., Movies:123456789',
		auto_detect_label: 'Auto detect links',
		auto_detect_hint: 'Automatically detect magnet/ed2k links on all web pages (requires extra permission)',
	},
}

let configCache = { ...DEFAULT_CONFIG }

function t(key) {
	const locale = configCache[CONFIG_KEYS.I18N_LOCALE] || 'zh-CN'
	const strings = I18N_STRINGS[locale] || I18N_STRINGS['zh-CN']
	return strings[key] || key
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

function getConfig(key) {
	return configCache[key]
}

function setConfig(key, value) {
	configCache[key] = value
	chrome.storage.local.set({ [key]: value })
}
function setBtnContent(btnId, iconSrc, text) {
	const btn = document.getElementById(btnId)
	if (!btn) return
	btn.textContent = ''
	const img = document.createElement('img')
	img.src = iconSrc
	img.width = 16
	img.height = 16
	btn.appendChild(img)
	btn.appendChild(document.createTextNode(' ' + text))
}

function showStatus(type, msg, timeout = 3000) {
	const area = document.getElementById('push115-status-area')
	area.textContent = ''
	const div = document.createElement('div')
	div.className = `push115-status ${type}`
	div.textContent = msg
	area.appendChild(div)
	if (timeout) {
		setTimeout(() => (area.textContent = ''), timeout)
	}
}

function getTaskStatusLabel(status) {
	const label = t(`task_status_${status}`)
	return label === `task_status_${status}` ? status : label
}

function getTaskDisplayName(task) {
	return task.code || task.remoteName || task.title || '115 task'
}

function replaceTaskCount(text, count) {
	return String(text || '').replace('{count}', String(count))
}

function getSortedTasks(tasks) {
	return [...(Array.isArray(tasks) ? tasks : [])].sort(
		(a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
	)
}

function formatTaskTime(value) {
	const timestamp = Number(value)
	if (!Number.isFinite(timestamp) || timestamp <= 0) return '--'
	return new Date(timestamp).toLocaleString(configCache[CONFIG_KEYS.I18N_LOCALE] || 'zh-CN', { hour12: false })
}

function getNormalizedTaskStatus(task) {
	return ['waiting', 'processing', 'recorded', 'completed', 'failed', 'cancelled'].includes(task?.status) ? task.status : 'recorded'
}

function addTaskRetryButton(parent, task) {
	const retry = document.createElement('button')
	retry.className = 'push115-task-retry'
	retry.type = 'button'
	retry.textContent = t('task_retry')
	retry.addEventListener('click', async () => {
		retry.disabled = true
		try {
			await sendMessage('RETRY_TASK', { taskId: task.taskId })
			await refreshTaskList()
		} catch (error) {
			showStatus('error', error.message)
			retry.disabled = false
		}
	})
	parent.appendChild(retry)
}

function appendTaskLogs(parent, task) {
	const logs = Array.isArray(task.logs) ? task.logs : []
	const details = document.createElement('details')
	details.className = 'push115-task-logs'
	details.open = task.status === 'failed' || task.status === 'processing'
	const summary = document.createElement('summary')
	summary.textContent = `${t('task_logs')} (${logs.length})`
	details.appendChild(summary)

	if (logs.length === 0) {
		const empty = document.createElement('div')
		empty.className = 'push115-task-log-entry'
		empty.textContent = t('no_background_tasks')
		details.appendChild(empty)
	} else {
		for (const log of logs.slice(-60)) {
			const entry = document.createElement('div')
			entry.className = 'push115-task-log-entry'
			const time = document.createElement('time')
			time.textContent = formatTaskTime(log.at)
			const message = document.createElement('span')
			message.textContent = log.message || ''
			entry.append(time, message)
			details.appendChild(entry)
		}
	}

	parent.appendChild(details)
}

function renderTaskList(tasks = []) {
	const listEl = document.getElementById('push115-task-list')
	if (!listEl) return

	listEl.textContent = ''
	const visibleTasks = getSortedTasks(tasks).slice(0, 8)
	if (visibleTasks.length === 0) {
		const empty = document.createElement('div')
		empty.className = 'push115-task-empty'
		empty.textContent = t('no_background_tasks')
		listEl.appendChild(empty)
		return
	}

	for (const task of visibleTasks) {
		const item = document.createElement('div')
		item.className = `push115-task-item ${getNormalizedTaskStatus(task)}`

		const top = document.createElement('div')
		top.className = 'push115-task-top'
		const name = document.createElement('strong')
		name.textContent = getTaskDisplayName(task)
		const status = document.createElement('span')
		status.className = 'push115-task-status'
		status.textContent = getTaskStatusLabel(getNormalizedTaskStatus(task))
		top.append(name, status)
		item.appendChild(top)

		const message = document.createElement('div')
		message.className = 'push115-task-message'
		message.textContent = task.message || ''
		item.appendChild(message)

		if (task.status === 'failed') addTaskRetryButton(item, task)
		listEl.appendChild(item)
	}
}

function renderTaskManager(tasks = []) {
	const listEl = document.getElementById('push115-task-manager-list')
	const summaryEl = document.getElementById('push115-task-manager-summary')
	if (!listEl || !summaryEl) return

	const visibleTasks = getSortedTasks(tasks).slice(0, 30)
	summaryEl.textContent = replaceTaskCount(t('task_summary'), visibleTasks.length)
	listEl.textContent = ''
	if (visibleTasks.length === 0) {
		const empty = document.createElement('div')
		empty.className = 'push115-task-manager-empty'
		empty.textContent = t('no_background_tasks')
		listEl.appendChild(empty)
		return
	}

	for (const task of visibleTasks) {
		const status = getNormalizedTaskStatus(task)
		const item = document.createElement('article')
		item.className = `push115-task-manager-item ${status}`

		const top = document.createElement('div')
		top.className = 'push115-task-manager-top'
		const name = document.createElement('strong')
		name.textContent = getTaskDisplayName(task)
		const statusEl = document.createElement('span')
		statusEl.className = 'push115-task-manager-status'
		statusEl.textContent = getTaskStatusLabel(status)
		top.append(name, statusEl)
		item.appendChild(top)

		const meta = document.createElement('div')
		meta.className = 'push115-task-manager-meta'
		meta.textContent = [
			task.remoteName ? `任务：${task.remoteName}` : '',
			task.title || '',
			task.source || '',
			task.message || '',
			formatTaskTime(task.updatedAt || task.createdAt),
		].filter(Boolean).join(' · ')
		item.appendChild(meta)

		if (status === 'failed') {
			const actions = document.createElement('div')
			actions.className = 'push115-task-manager-actions'
			addTaskRetryButton(actions, task)
			item.appendChild(actions)
		}

		appendTaskLogs(item, task)
		listEl.appendChild(item)
	}
}

function renderTaskViews(tasks = []) {
	renderTaskList(tasks)
}

async function refreshTaskList() {
	try {
		const response = await sendMessage('GET_TASKS')
		renderTaskViews(response.tasks || [])
	} catch (error) {
		console.error('读取后台任务失败:', error)
	}
}

function applyTheme(theme) {
	document.body.classList.remove('dark-theme')
	if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
		document.body.classList.add('dark-theme')
	}
}

function setText(id, value) {
	const element = document.getElementById(id)
	if (element) element.textContent = value
}

function setPlaceholder(id, value) {
	const element = document.getElementById(id)
	if (element) element.placeholder = value
}

function setValue(id, value) {
	const element = document.getElementById(id)
	if (element) element.value = value
}

function setChecked(id, value) {
	const element = document.getElementById(id)
	if (element) element.checked = value === true
}

function applyLocale() {
	// Update all visible text elements.  The popup is intentionally a single
	// page now; optional setters keep older or compact markup harmless.
	setText('push115-title-text', t('panel_title'))
	setText('label-manual-download', t('manual_download_label'))
	setPlaceholder('push115-manual-downloads', t('manual_download_placeholder'))
	setText('push115-open-download-confirmation', t('manual_download_continue'))
	setText('push115-quick-add-title', t('quick_add_title'))
	setText('push115-quick-add-hint', t('quick_add_hint'))
	setText('push115-local-badge', t('local_badge'))
	setText('push115-recent-tasks-hint', t('recent_tasks_hint'))
	setText('push115-quick-options-title', t('quick_options_title'))
	setText('push115-quick-options-hint', t('quick_options_hint'))
	setText('hint-safe-cleanup', t('safe_cleanup_hint'))
	setText('push115-preferences-title', t('preferences_title'))
	setText('label-save-path', t('save_path_label'))
	setText('hint-cid', t('cid_hint'))
	setText('label-save-dirs', t('settings_save_dirs_label'))
	setPlaceholder('push115-save-dirs-input', t('save_dirs_placeholder'))
	setText('hint-save-dirs', t('save_dirs_hint'))
	setText('label-auto-delete', t('auto_delete_label'))
	setText('label-delete-pre', t('delete_size_label_pre'))
	setText('label-delete-post', t('delete_size_label_post'))
	setText('hint-delete-safe', t('delete_safe_hint'))
	setText('label-auto-organize', t('auto_organize_label'))
	setText('hint-organize', t('organize_hint'))
	setText('label-auto-detect', t('auto_detect_label'))
	setText('hint-auto-detect', t('auto_detect_hint'))
	setBtnContent('push115-check-login', 'icons/check.png', t('check_login_text'))
	setBtnContent('push115-login-btn', 'icons/115.png', t('login_btn'))
	setText('label-background-tasks', t('background_tasks_label'))
	setText('push115-open-task-manager', t('open_task_manager'))
	setText('label-task-manager', t('tab_tasks'))
	setText('hint-task-manager', t('manage_tasks_hint'))
	setText('push115-refresh-tasks', t('refresh_tasks'))
	setText('push115-open-options', t('open_options'))
	setText('hint-open-options', t('open_options_hint'))
	setText('push115-open-options-from-tasks', t('open_options'))
	setText('hint-options-from-tasks', t('open_options_hint'))
	setText('push115-language-label', t('settings_language_label'))
	setText('push115-theme-label', t('settings_theme_label'))
	setText('push115-theme-option-auto', t('theme_auto'))
	setText('push115-theme-option-light', t('theme_light'))
	setText('push115-theme-option-dark', t('theme_dark'))

	renderSaveDirSelect()
	void refreshTaskList()
}

function getRootLabel() {
	return t('root_path_name')
}

function renderSaveDirSelect() {
	const selectEl = document.getElementById('push115-save-dir-select')
	if (!selectEl || !window.Push115?.PathUtils) return

	const savedCid = Push115.PathUtils.normalizeCid(getConfig(CONFIG_KEYS.SAVE_PATH_CID)) || '0'
	const listText = getConfig(CONFIG_KEYS.SAVE_PATH_LIST) || ''
	const options = Push115.PathUtils.buildPathOptions(listText, getRootLabel())
	const hasSaved = options.some(item => item.cid === savedCid)

	const allOptions = hasSaved ? options : [...options, { name: '', cid: savedCid }]
	selectEl.textContent = ''
	allOptions.forEach(item => {
		const opt = document.createElement('option')
		opt.value = item.cid
		opt.textContent = Push115.PathUtils.formatPathLabel(item, getRootLabel())
		if (item.cid === savedCid) opt.selected = true
		selectEl.appendChild(opt)
	})
}

async function init() {
	Push115.Content.Styles.ensure()
	// Load config
	const items = await chrome.storage.local.get(null)
	configCache = { ...DEFAULT_CONFIG, ...items }
	configCache[CONFIG_KEYS.SITE_PROFILES] = Push115.Config.normalizeSiteProfiles(
		items[CONFIG_KEYS.SITE_PROFILES],
		configCache,
	)

	// Apply theme & locale
	applyTheme(getConfig(CONFIG_KEYS.THEME))
	applyLocale()

	setChecked('push115-auto-organize', getConfig(CONFIG_KEYS.AUTO_ORGANIZE))
	setChecked('push115-auto-delete', getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL))
	setValue('push115-delete-size', getConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD))
	setValue('push115-language-select', getConfig(CONFIG_KEYS.I18N_LOCALE))
	setValue('push115-theme-select', getConfig(CONFIG_KEYS.THEME))
	setValue('push115-save-dirs-input', getConfig(CONFIG_KEYS.SAVE_PATH_LIST))
	setChecked('push115-auto-detect', getConfig(CONFIG_KEYS.AUTO_DETECT))
	renderSaveDirSelect()
	await refreshTaskList()

	const deleteSection = document.getElementById('push115-delete-section')
	if (deleteSection) deleteSection.style.display = getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL) ? 'block' : 'none'

	// Bind events
	bindEvents()
	bindLoginModalEvents()
	// Opening the popup grants activeTab for the current page. Use that
	// temporary grant as a best-effort fallback when a dedicated site's
	// optional origin has not been approved yet.
	void sendMessage('INJECT_ACTIVE_TAB').catch(() => {})
}

function onElement(id, event, handler) {
	const element = document.getElementById(id)
	if (element) element.addEventListener(event, handler)
}

function bindEvents() {
	onElement('push115-open-download-confirmation', 'click', () => {
		const initialText = document.getElementById('push115-manual-downloads').value
		const genericProfile = configCache[CONFIG_KEYS.SITE_PROFILES]?.generic || {}
		void Push115.Content.ConfirmModal.show({
			initialText,
			sourceSite: 'generic',
			defaultProcessorProfile: genericProfile.defaultProcessorProfile || 'generic',
			defaultSavePathCid: genericProfile.defaultSavePathCid || getConfig(CONFIG_KEYS.SAVE_PATH_CID),
			batchConcurrency: 2,
		})
	})

	onElement('push115-theme-select', 'change', e => {
		setConfig(CONFIG_KEYS.THEME, e.target.value)
		applyTheme(e.target.value)
	})

	onElement('push115-language-select', 'change', e => {
		setConfig(CONFIG_KEYS.I18N_LOCALE, e.target.value)
		applyLocale()
	})

	onElement('push115-save-dirs-input', 'change', e => {
		setConfig(CONFIG_KEYS.SAVE_PATH_LIST, e.target.value)
		renderSaveDirSelect()
	})

	onElement('push115-auto-organize', 'change', e => {
		setConfig(CONFIG_KEYS.AUTO_ORGANIZE, e.target.checked)
	})

	onElement('push115-auto-detect', 'change', async e => {
		const checkbox = e.target
		if (checkbox.checked) {
			try {
				const granted = await chrome.permissions.request({ origins: ['<all_urls>'] })
				if (granted) {
					const profiles = Push115.Config.normalizeSiteProfiles(getConfig(CONFIG_KEYS.SITE_PROFILES), configCache)
					profiles.generic.enabled = true
					configCache[CONFIG_KEYS.AUTO_DETECT] = true
					configCache[CONFIG_KEYS.SITE_PROFILES] = profiles
					await chrome.storage.local.set({
						[CONFIG_KEYS.AUTO_DETECT]: true,
						[CONFIG_KEYS.SITE_PROFILES]: profiles,
					})
					await sendMessage('SYNC_CONTENT_SCRIPTS')
					showStatus('success', t('auto_detect_label') + ' ✓')
				} else {
					checkbox.checked = false
				}
			} catch (err) {
				console.error('Permission request error:', err)
				checkbox.checked = false
			}
		} else {
			const profiles = Push115.Config.normalizeSiteProfiles(getConfig(CONFIG_KEYS.SITE_PROFILES), configCache)
			profiles.generic.enabled = false
			configCache[CONFIG_KEYS.AUTO_DETECT] = false
			configCache[CONFIG_KEYS.SITE_PROFILES] = profiles
			await chrome.storage.local.set({
				[CONFIG_KEYS.AUTO_DETECT]: false,
				[CONFIG_KEYS.SITE_PROFILES]: profiles,
			})
			await sendMessage('SYNC_CONTENT_SCRIPTS')
		}
	})

	onElement('push115-auto-delete', 'change', e => {
		setConfig(CONFIG_KEYS.AUTO_DELETE_SMALL, e.target.checked)
		const section = document.getElementById('push115-delete-section')
		if (section) section.style.display = e.target.checked ? 'block' : 'none'
	})

	onElement('push115-delete-size', 'change', e => {
		setConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD, e.target.value)
	})

	onElement('push115-save-dir-select', 'change', e => {
		const cid = Push115.PathUtils.normalizeCid(e.target.value) || '0'
		const listText = getConfig(CONFIG_KEYS.SAVE_PATH_LIST) || ''
		const found = Push115.PathUtils.findPathByCid(listText, cid)
		setConfig(CONFIG_KEYS.SAVE_PATH_CID, cid)
		setConfig(CONFIG_KEYS.SAVE_PATH, cid === '0' ? '' : found?.name || '')
		renderSaveDirSelect()
	})

	onElement('push115-check-login', 'click', async () => {
		const btn = document.getElementById('push115-check-login')
		if (!btn) return
		btn.disabled = true
		setBtnContent('push115-check-login', 'icons/check.png', t('processing'))
		try {
			const response = await sendMessage('API_REQUEST', {
				url: 'https://my.115.com/?ct=guide&ac=status',
				method: 'GET',
			})
			const isLogin = response.data && response.data.state === true
			showStatus(isLogin ? 'success' : 'error', isLogin ? t('login_success') : t('login_fail'))
		} catch (e) {
			showStatus('error', t('login_fail'))
		}
		btn.disabled = false
		setBtnContent('push115-check-login', 'icons/check.png', t('check_login_text'))
	})

	onElement('push115-login-btn', 'click', () => {
		showLoginModal()
	})

	onElement('push115-open-task-manager', 'click', () => {
		chrome.runtime.openOptionsPage()
	})

	onElement('push115-refresh-tasks', 'click', refreshTaskList)

	onElement('push115-open-options', 'click', () => {
		chrome.runtime.openOptionsPage()
	})
	onElement('push115-open-options-from-tasks', 'click', () => {
		chrome.runtime.openOptionsPage()
	})
}

// ========== QR Login Modal ==========

const APP_DESCRIPTIONS = {
	web: '请使用 115 App 扫码',
	ios: '请使用 115 App (iOS端) 扫码',
	android: '请使用 115 App (Android端) 扫码',
	ipad: '请使用 115 App (iPad端) 扫码',
	tv: '请使用 115 App (Android电视端) 扫码',
	qios: '请使用 115管理 App (iOS端) 扫码',
	qandroid: '请使用 115管理 App (Android端) 扫码',
	wechatmini: '请使用 微信 扫码 (115生活小程序)',
	alipaymini: '请使用 支付宝 扫码 (115生活小程序)',
}

let stopPolling = false

function showLoginModal() {
	const modal = document.getElementById('push115-login-modal')
	modal.style.display = 'flex'
	stopPolling = false

	// Reset to select area
	document.getElementById('push115-login-select-area').style.display = 'block'
	document.getElementById('push115-qrcode-area').style.display = 'none'
	const qrWrapper = document.getElementById('push115-qrcode-wrapper')
	qrWrapper.textContent = ''
	const spinner = document.createElement('span')
	spinner.className = 'push115-loading'
	qrWrapper.appendChild(spinner)
	document.getElementById('push115-qrcode-status').textContent = '正在获取二维码...'
	updateQRTip()
}

function hideLoginModal() {
	stopPolling = true
	document.getElementById('push115-login-modal').style.display = 'none'
}

function updateQRTip() {
	const val = document.getElementById('push115-app-select').value
	const tipEl = document.getElementById('push115-qrcode-tip')
	if (tipEl && APP_DESCRIPTIONS[val]) {
		tipEl.textContent = APP_DESCRIPTIONS[val]
	}
}

// Bind modal events (called once during init)
function bindLoginModalEvents() {
	// Cancel button
	document.getElementById('push115-login-cancel').addEventListener('click', hideLoginModal)

	// Click overlay to close
	document.getElementById('push115-login-modal').addEventListener('click', e => {
		if (e.target.id === 'push115-login-modal') hideLoginModal()
	})

	// ESC to close
	document.addEventListener('keydown', e => {
		if (e.key === 'Escape') hideLoginModal()
	})

	// App select change -> update tip
	document.getElementById('push115-app-select').addEventListener('change', updateQRTip)

	// Start scan button
	document.getElementById('push115-login-start').addEventListener('click', () => {
		const selectedApp = document.getElementById('push115-app-select').value
		document.getElementById('push115-login-select-area').style.display = 'none'
		document.getElementById('push115-qrcode-area').style.display = 'block'
		startLoginFlow(selectedApp)
	})
}

async function startLoginFlow(selectedApp) {
	try {
		// 1. Get QR Token
		const tokenResp = await sendMessage('API_REQUEST', {
			url: 'https://qrcodeapi.115.com/api/1.0/web/1.0/token/',
			method: 'GET',
		})
		const tokenResult = tokenResp.data
		if (!tokenResult || tokenResult.state !== 1 || !tokenResult.data || !tokenResult.data.uid) {
			throw new Error('获取二维码 Token 失败')
		}

		const { uid, time, sign } = tokenResult.data

		// 2. Show QR Code
		const wrapper = document.getElementById('push115-qrcode-wrapper')
		if (wrapper) {
			wrapper.textContent = ''
			const qrImg = document.createElement('img')
			qrImg.src = `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=${encodeURIComponent(uid)}&_=${Date.now()}`
			wrapper.appendChild(qrImg)
		}

		const statusEl = document.getElementById('push115-qrcode-status')
		if (statusEl) statusEl.textContent = '请扫描二维码'

		// 3. Poll status
		while (!stopPolling) {
			try {
				const statusResp = await sendMessage('API_REQUEST', {
					url: `https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}&_=${Date.now()}`,
					method: 'GET',
				})
				const statusResult = statusResp.data
				if (!statusResult || statusResult.state !== 1 || !statusResult.data) {
					throw new Error('获取二维码状态失败')
				}

				const status = statusResult.data.status

				if (status === 0) {
					if (statusEl) statusEl.textContent = '请扫描二维码'
				} else if (status === 1) {
					if (statusEl) statusEl.textContent = '已扫码，请在手机上确认'
				} else if (status === 2) {
					if (statusEl) statusEl.textContent = '登录成功！正在获取 Cookie...'

					// 4. Exchange for cookie
					try {
						const loginResp = await sendMessage('API_REQUEST', {
							url: `https://passportapi.115.com/app/1.0/${selectedApp}/1.0/login/qrcode/`,
							method: 'POST',
							data: { account: uid, app: selectedApp },
						})

						const loginResult = loginResp.data
						if (!loginResult || loginResult.state !== 1 || !loginResult.data?.cookie) {
							throw new Error(loginResult?.error || '登录失败')
						}

						await sendMessage('SET_COOKIE', {
							cookie: loginResult.data.cookie,
						})

						if (statusEl) statusEl.textContent = ' 登录完成'
						setTimeout(() => {
							hideLoginModal()
							showStatus('success', ` 115 登录成功 (${selectedApp})，Cookie 已保存`)
						}, 1000)
					} catch (loginErr) {
						console.error('Login Error:', loginErr)
						if (statusEl) statusEl.textContent = ' 获取Cookie失败: ' + loginErr.message
						stopPolling = true
					}
					break
				} else if (status === -1) {
					if (statusEl) statusEl.textContent = '二维码已过期，请重试'
					break
				} else if (status === -2) {
					if (statusEl) statusEl.textContent = '已取消登录'
					break
				}

				await new Promise(r => setTimeout(r, 1500))
			} catch (e) {
				console.error('轮询状态错误:', e)
				await new Promise(r => setTimeout(r, 2000))
			}
		}
	} catch (e) {
		console.error('登录流程错误:', e)
		const statusEl = document.getElementById('push115-qrcode-status')
		if (statusEl) statusEl.textContent = ' 发生错误: ' + e.message
	}
}

chrome.runtime.onMessage.addListener(request => {
	if (request.action === 'TASK_UPDATED') void refreshTaskList()
})

// Start
document.addEventListener('DOMContentLoaded', init)
