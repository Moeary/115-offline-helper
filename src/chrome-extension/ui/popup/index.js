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
	return ['waiting', 'processing', 'recorded', 'completed', 'failed'].includes(task?.status) ? task.status : 'recorded'
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
	renderTaskManager(tasks)
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

function applyLocale() {
	// Update all text elements
	document.getElementById('push115-title-text').textContent = t('panel_title')
	document.getElementById('label-manual-download').textContent = t('manual_download_label')
	document.getElementById('push115-manual-downloads').placeholder = t('manual_download_placeholder')
	document.getElementById('push115-open-download-confirmation').textContent = t('manual_download_continue')
	document.querySelector('[data-tab="home"]').textContent = t('tab_home')
	document.querySelector('[data-tab="tasks"]').textContent = t('tab_tasks')
	document.querySelector('[data-tab="settings"]').textContent = t('tab_settings')
	document.getElementById('label-save-path').textContent = t('save_path_label')
	document.getElementById('hint-cid').textContent = t('cid_hint')
	document.getElementById('label-save-dirs').textContent = t('settings_save_dirs_label')
	document.getElementById('push115-save-dirs-input').placeholder = t('save_dirs_placeholder')
	document.getElementById('hint-save-dirs').textContent = t('save_dirs_hint')
	document.getElementById('label-auto-delete').textContent = t('auto_delete_label')
	document.getElementById('label-delete-pre').textContent = t('delete_size_label_pre')
	document.getElementById('label-delete-post').textContent = t('delete_size_label_post')
	document.getElementById('hint-delete-safe').textContent = t('delete_safe_hint')
	document.getElementById('label-auto-organize').textContent = t('auto_organize_label')
	document.getElementById('hint-organize').textContent = t('organize_hint')
	document.getElementById('label-auto-detect').textContent = t('auto_detect_label')
	document.getElementById('hint-auto-detect').textContent = t('auto_detect_hint')
	setBtnContent('push115-check-login', 'icons/check.png', t('check_login_text'))
	setBtnContent('push115-login-btn', 'icons/115.png', t('login_btn'))
	document.getElementById('label-background-tasks').textContent = t('background_tasks_label')
	document.getElementById('push115-open-task-manager').textContent = t('open_task_manager')
	document.getElementById('label-task-manager').textContent = t('tab_tasks')
	document.getElementById('hint-task-manager').textContent = t('manage_tasks_hint')
	document.getElementById('push115-refresh-tasks').textContent = t('refresh_tasks')
	document.getElementById('push115-open-options').textContent = t('open_options')
	document.getElementById('hint-open-options').textContent = t('open_options_hint')
	document.getElementById('push115-open-options-from-tasks').textContent = t('open_options')
	document.getElementById('hint-options-from-tasks').textContent = t('open_options_hint')

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

	document.getElementById('push115-auto-organize').checked = getConfig(CONFIG_KEYS.AUTO_ORGANIZE)
	document.getElementById('push115-auto-delete').checked = getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL)
	document.getElementById('push115-delete-size').value = getConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD)
	document.getElementById('push115-language-select').value = getConfig(CONFIG_KEYS.I18N_LOCALE)
	document.getElementById('push115-theme-select').value = getConfig(CONFIG_KEYS.THEME)
	document.getElementById('push115-save-dirs-input').value = getConfig(CONFIG_KEYS.SAVE_PATH_LIST)
	document.getElementById('push115-auto-detect').checked = getConfig(CONFIG_KEYS.AUTO_DETECT)
	renderSaveDirSelect()
	await refreshTaskList()

	if (getConfig(CONFIG_KEYS.AUTO_DELETE_SMALL)) {
		document.getElementById('push115-delete-section').style.display = 'block'
	}

	// Bind events
	bindEvents()
	bindLoginModalEvents()
}

function activateTab(tabName) {
	document.querySelectorAll('.push115-tab').forEach(tab => tab.classList.remove('active'))
	document.querySelectorAll('.push115-tab-content').forEach(content => content.classList.remove('active'))
	const tab = document.querySelector(`.push115-tab[data-tab="${tabName}"]`)
	const content = document.getElementById(`push115-tab-${tabName}`)
	if (tab) tab.classList.add('active')
	if (content) content.classList.add('active')
}

function bindEvents() {
	// Tab switching
	document.querySelectorAll('.push115-tab').forEach(tab => {
		tab.addEventListener('click', () => activateTab(tab.dataset.tab))
	})

	document.getElementById('push115-open-download-confirmation').addEventListener('click', () => {
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

	// Theme
	document.getElementById('push115-theme-select').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.THEME, e.target.value)
		applyTheme(e.target.value)
	})

	// Language
	document.getElementById('push115-language-select').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.I18N_LOCALE, e.target.value)
		applyLocale()
	})

	// Save directory list config
	document.getElementById('push115-save-dirs-input').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.SAVE_PATH_LIST, e.target.value)
		renderSaveDirSelect()
	})

	// Auto organize
	document.getElementById('push115-auto-organize').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.AUTO_ORGANIZE, e.target.checked)
	})

	// Auto detect toggle
	document.getElementById('push115-auto-detect').addEventListener('change', async e => {
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

	// Auto delete
	document.getElementById('push115-auto-delete').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.AUTO_DELETE_SMALL, e.target.checked)
		document.getElementById('push115-delete-section').style.display = e.target.checked ? 'block' : 'none'
	})

	document.getElementById('push115-delete-size').addEventListener('change', e => {
		setConfig(CONFIG_KEYS.DELETE_SIZE_THRESHOLD, e.target.value)
	})

	// Save directory
	document.getElementById('push115-save-dir-select').addEventListener('change', e => {
		const cid = Push115.PathUtils.normalizeCid(e.target.value) || '0'
		const listText = getConfig(CONFIG_KEYS.SAVE_PATH_LIST) || ''
		const found = Push115.PathUtils.findPathByCid(listText, cid)
		setConfig(CONFIG_KEYS.SAVE_PATH_CID, cid)
		setConfig(CONFIG_KEYS.SAVE_PATH, cid === '0' ? '' : found?.name || '')
		renderSaveDirSelect()
	})

	// Check Login
	document.getElementById('push115-check-login').addEventListener('click', async () => {
		const btn = document.getElementById('push115-check-login')
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

	// Login Button - open modal
	document.getElementById('push115-login-btn').addEventListener('click', () => {
		showLoginModal()
	})

	// Open the in-popup task manager from the Home tab
	document.getElementById('push115-open-task-manager').addEventListener('click', () => {
		activateTab('tasks')
	})

	document.getElementById('push115-refresh-tasks').addEventListener('click', refreshTaskList)

	// Full settings and logs page
	document.getElementById('push115-open-options').addEventListener('click', () => {
		chrome.runtime.openOptionsPage()
	})
	document.getElementById('push115-open-options-from-tasks').addEventListener('click', () => {
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
