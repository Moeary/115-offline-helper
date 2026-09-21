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
	BRIDGE_ENABLED: 'push115_bridge_enabled',
	BRIDGE_TOKEN: 'push115_bridge_token',
	BRIDGE_PAIRED: 'push115_bridge_paired',
	BRIDGE_TARGET_CID: 'push115_bridge_target_cid',
}
const DIRECTORY_INDEX_KEY = 'push115_directory_index'

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
	[CONFIG_KEYS.BRIDGE_ENABLED]: false,
	[CONFIG_KEYS.BRIDGE_TOKEN]: '',
	[CONFIG_KEYS.BRIDGE_PAIRED]: false,
	[CONFIG_KEYS.BRIDGE_TARGET_CID]: '0',
}

const SETTINGS_PAGES = Object.freeze(['general', 'directories', 'sites', 'bridge', 'rules', 'logs'])
let activeSettingsPage = 'general'

const I18N_STRINGS = {
	'zh-CN': {
		page_title: '115离线助手设置',
		page_subtitle: '规则、任务与日志集中管理',
		settings_nav_title: '设置导航',
		settings_nav_general: '常规',
		settings_nav_directories: '目录同步',
		settings_nav_sites: '站点规则',
		settings_nav_bridge: 'Bridge / Telegram',
		settings_nav_rules: '文件规则',
		settings_nav_logs: '任务日志',
		settings_nav_hint: '切换分页不会丢失未保存内容；完成修改后点击底部保存。',
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
		threshold_hint: '小视频阈值只在站点卡片启用后生效；主视频、CD/Disc/Part 分片不会因体积小而删除。默认仅 AV 站点启用。',
		save_dirs_label: '115 离线目录（一行一个）',
		save_dirs_placeholder: '例如：电影:123456789',
		save_dirs_hint: '格式：目录名:CID，例如：电影:123456789；“加入”只把已扫描目录加入扩展的保存目录列表，不会创建目录或立即下载。Telegram /dir 的“使用当前目录”是单独的临时选择；站点规则会按各自默认 CID 自动入队。',
		directory_index_title: '115 目录索引',
		directory_index_hint: '先扫描根目录一级；可将目录加入上方列表，或显式扫描它的子目录并同步给本地 Bridge。JavBus、Nyaa 等站点会使用各自站点规则中的默认 CID；Telegram /dir 的选择优先级最高。',
		directory_scan_button: '扫描目录',
		directory_scan_empty: '尚未扫描目录。请保持 115 登录状态后点击“扫描目录”。',
		directory_scan_root: '根目录',
		directory_scan_selected: '已加入',
		directory_scan_add: '加入',
		directory_scan_remove: '移除',
		directory_scan_children: '扫描子目录',
		directory_scan_success: '已扫描 {count} 个目录；Bridge 同步状态：{bridge}。',
		directory_scan_truncated: '扫描已受预算限制，结果可能不完整（{reason}，请求 {requests} 次）。',
		directory_scan_failed: '目录扫描失败：',
		directory_bridge_synced: '已同步',
		directory_bridge_pending: '待同步',
		directory_bridge_disabled: 'Bridge 未启用',
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
		sites_title: '站点增强',
		sites_subtitle: '每个站点独立控制启用状态、保存目录、页面增强方式、后台 processor 和小视频阈值清理；保存目录选项来自上方目录列表。JavBus 通常选择 AV 目录，Anime 站点选择番剧目录。',
		bridge_title: '本地服务连接',
		bridge_subtitle: '从本机服务领取候选任务并提交到 115。地址固定为 http://127.0.0.1:52115，不会读取网页 Cookie。',
		bridge_enabled_label: '启用本地服务连接',
		bridge_enabled_hint: '启用后每 30 秒探测并领取任务；Bridge 晚于浏览器启动也会自动连接。关闭时不会请求本地服务。',
		bridge_token_label: '连接密钥',
		bridge_token_hint: '密钥仅保存在本机，用于连接本地服务；115 登录信息留在浏览器。',
		bridge_target_label: 'Bridge 默认目录',
		bridge_target_hint: '仅当领取的任务未指定 CID 时使用；未配置时使用根目录。',
		bridge_permission_hint: '首次启用会请求 http://127.0.0.1/* 的可选权限。',
		bridge_permission_denied: '未获得本地 Bridge 权限，Bridge 保持关闭。',
		bridge_token_required: '启用 Bridge 前请填写 Bearer token。',
		bridge_bootstrap_title: '自动连接',
		bridge_bootstrap_hint: '扩展只连接固定的本机 Bridge；后台会持续探测端口，首次可用时自动取得并保存 Bearer 凭据，不需要配对码或五分钟窗口。',
		bridge_refresh_button: '检查 Bridge',
		bridge_connect_button: '连接本机 Bridge',
		bridge_status_label: 'Bridge 状态',
		bridge_advanced_title: '高级配置（手工 token / 目录）',
		bridge_status_unavailable: '未发现本地 Bridge',
		bridge_status_connected: '已连接',
		bridge_status_connecting: '正在连接……',
		bridge_connect_success: 'Bridge 已连接；正在同步目录。',
		bridge_connect_failed: 'Bridge 连接失败：',
		bridge_sync_pending: '目录将在 Bridge 可用后同步。',
		bridge_sync_success: 'Bridge 已连接；目录已同步 {count} 项（修订 {revision}）。',
		bridge_sync_empty: 'Bridge 已连接；尚未建立目录索引，请先扫描 115 目录。',
		bridge_sync_failed: 'Bridge 已连接，但目录同步失败：',
		telegram_title: 'Telegram Bot',
		telegram_hint: 'Bot Token 只用于配置本地 Bridge；扩展不会在状态、日志或页面文字中回显它。',
		telegram_refresh_button: '刷新状态',
		telegram_token_label: 'Bot Token',
		telegram_token_hint: '仅在首次配置或更换 Bot 时填写；读取状态不会返回 token。',
		telegram_connect_button: '连接 Telegram',
		telegram_start_button: '启动',
		telegram_stop_button: '停止',
		telegram_restart_button: '重启',
		telegram_status_label: 'Telegram 状态',
		telegram_bot_label: '机器人',
		telegram_owner_label: '管理员',
		telegram_owner_hint: '首次配置后，在机器人私聊中发送 /start 即可自动绑定当前管理员。',
		telegram_status_unavailable: '未配置或 Bridge 未连接',
		telegram_status_enabled: '运行中',
		telegram_status_disabled: '已停止',
		telegram_configured: '已配置',
		telegram_not_configured: '未配置',
		telegram_owner_bound: '已绑定',
		telegram_owner_unbound: '未绑定',
		telegram_bot_unknown: '未知',
		telegram_action_failed: 'Telegram 操作失败：',
		telegram_action_success: 'Telegram 设置已更新。',
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
		confirm_complete_reset: '确定完全重置扩展本地任务吗？这会清除全部任务记录、处理计划、Mikan 番组绑定和去重回执；不会取消 115 云端任务，也不会修改登录信息、目录或站点设置；Bridge 已领取任务、租约回执和事件 outbox 会保留，避免重复提交。',
		complete_reset_success: '已清除本地任务 {tasks} 条、番组绑定 {series} 个。115 云端任务未受影响；Bridge 任务回执和事件 outbox 已保留。',
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
		task_status_cancelled: '已取消（仅本地）',
		task_retry: '重试',
		task_retry_failed: '重试失败：',
		refresh_failed: '读取日志失败：',
	},
	'en-US': {
		page_title: '115 Offline Helper Settings',
		page_subtitle: 'Manage rules, tasks, and logs in one place',
		settings_nav_title: 'Settings navigation',
		settings_nav_general: 'General',
		settings_nav_directories: 'Directories',
		settings_nav_sites: 'Site rules',
		settings_nav_bridge: 'Bridge / Telegram',
		settings_nav_rules: 'File rules',
		settings_nav_logs: 'Task logs',
		settings_nav_hint: 'Switching pages keeps unsaved changes; use Save at the bottom when finished.',
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
		threshold_hint: 'The threshold applies only to sites that enable small-video cleanup; main video and CD/Disc/Part files are protected. AV sites are enabled by default.',
		save_dirs_label: '115 offline directories (one per line)',
		save_dirs_placeholder: 'e.g. Movies:123456789',
		save_dirs_hint: 'Format: Name:CID, e.g. Movies:123456789. “Add” only adds a scanned directory to the extension save-path list; it does not create a directory or start a download. Telegram /dir is a separate per-user selection, while site rules provide automatic defaults.',
		directory_index_title: '115 directory index',
		directory_index_hint: 'Scan the root directory first; add folders above or explicitly scan their children, then sync the index to the local Bridge. JavBus, Nyaa, and other sites use their configured default CID; a Telegram /dir selection takes precedence.',
		directory_scan_button: 'Scan directories',
		directory_scan_empty: 'No directory scan yet. Keep 115 signed in, then click “Scan directories”.',
		directory_scan_root: 'Root directory',
		directory_scan_selected: 'Added',
		directory_scan_add: 'Add',
		directory_scan_remove: 'Remove',
		directory_scan_children: 'Scan children',
		directory_scan_success: 'Scanned {count} directories; Bridge sync: {bridge}.',
		directory_scan_truncated: 'The scan reached a safety budget; the result may be incomplete ({reason}, {requests} requests).',
		directory_scan_failed: 'Directory scan failed: ',
		directory_bridge_synced: 'synced',
		directory_bridge_pending: 'pending',
		directory_bridge_disabled: 'Bridge disabled',
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
		sites_title: 'Site enhancements',
		sites_subtitle: 'Control each site independently: enabled state, save directory, page enhancement, background processor, and small-video cleanup. JavBus usually targets AV; Anime sites usually target 番剧.',
		bridge_title: 'Local service connection',
		bridge_subtitle: 'Claim candidates from the local service and submit them to 115. The endpoint is fixed at http://127.0.0.1:52115; page cookies are never read.',
		bridge_enabled_label: 'Enable local service connection',
		bridge_enabled_hint: 'Probes and claims every 30 seconds when enabled; a Bridge started later is connected automatically. Disabled mode makes no local requests.',
		bridge_token_label: 'Connection key',
		bridge_token_hint: 'The key stays on this device and is used only for the local service; 115 login information stays in the browser.',
		bridge_target_label: 'Bridge default directory',
		bridge_target_hint: 'Used only when a claimed job has no CID; the root is used when none is configured.',
		bridge_permission_hint: 'Enabling for the first time requests the optional http://127.0.0.1/* permission.',
		bridge_permission_denied: 'The local Bridge permission was not granted; Bridge remains disabled.',
		bridge_token_required: 'Enter a Bearer token before enabling Bridge.',
		bridge_bootstrap_title: 'Automatic connection',
		bridge_bootstrap_hint: 'The extension connects only to the fixed local Bridge. The worker keeps probing the port and stores a Bearer credential automatically when it becomes available, without a pairing code or five-minute window.',
		bridge_refresh_button: 'Check Bridge',
		bridge_connect_button: 'Connect local Bridge',
		bridge_status_label: 'Bridge status',
		bridge_advanced_title: 'Advanced settings (manual token / directory)',
		bridge_status_unavailable: 'Local Bridge not found',
		bridge_status_connected: 'Connected',
		bridge_status_connecting: 'Connecting…',
		bridge_connect_success: 'Bridge connected; syncing the directory index.',
		bridge_connect_failed: 'Bridge connection failed: ',
		bridge_sync_pending: 'The directory will sync when Bridge is available.',
		bridge_sync_success: 'Bridge connected; synced {count} directories (revision {revision}).',
		bridge_sync_empty: 'Bridge connected; no directory index yet. Scan the 115 directories first.',
		bridge_sync_failed: 'Bridge connected, but directory sync failed: ',
		telegram_title: 'Telegram Bot',
		telegram_hint: 'The Bot Token is used only to configure the local Bridge; the extension never echoes it in status, logs, or page text.',
		telegram_refresh_button: 'Refresh status',
		telegram_token_label: 'Bot Token',
		telegram_token_hint: 'Enter it only for the first setup or when changing bots; status reads never return the token.',
		telegram_connect_button: 'Connect Telegram',
		telegram_start_button: 'Start',
		telegram_stop_button: 'Stop',
		telegram_restart_button: 'Restart',
		telegram_status_label: 'Telegram status',
		telegram_bot_label: 'Bot',
		telegram_owner_label: 'Owner',
		telegram_owner_hint: 'After setup, send /start in a private chat with the bot to bind the first owner automatically.',
		telegram_status_unavailable: 'Not configured or Bridge unavailable',
		telegram_status_enabled: 'Running',
		telegram_status_disabled: 'Stopped',
		telegram_configured: 'Configured',
		telegram_not_configured: 'Not configured',
		telegram_owner_bound: 'Bound',
		telegram_owner_unbound: 'Not bound',
		telegram_bot_unknown: 'Unknown',
		telegram_action_failed: 'Telegram action failed: ',
		telegram_action_success: 'Telegram settings updated.',
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
		confirm_complete_reset: 'Reset all local extension task state? This clears task records, processing plans, Mikan series bindings, and dedupe receipts. It does not cancel 115 cloud tasks or change login, directories, or site settings. Bridge claims, lease receipts, and the event outbox are retained to prevent duplicate submission.',
		complete_reset_success: 'Cleared {tasks} local task(s) and {series} series binding(s). 115 cloud tasks were not changed; Bridge claims, receipts, and the event outbox were retained.',
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
		task_status_cancelled: 'Cancelled (local only)',
		task_retry: 'Retry',
		task_retry_failed: 'Retry failed: ',
		refresh_failed: 'Failed to read logs: ',
	},
}

let configCache = { ...DEFAULT_CONFIG }
let directoryIndex = { schema: 1, revision: 0, scannedAt: 0, roots: ['0'], directories: [] }

function t(key) {
	const locale = configCache[CONFIG_KEYS.I18N_LOCALE] || 'zh-CN'
	const strings = I18N_STRINGS[locale] || I18N_STRINGS['zh-CN']
	return strings[key] || key
}

function normalizeSettingsPage(value) {
	const page = String(value || '').trim().toLowerCase()
	return SETTINGS_PAGES.includes(page) ? page : 'general'
}

function applySettingsPage(value, options = {}) {
	const page = normalizeSettingsPage(value)
	activeSettingsPage = page
	if (options.updateHash !== false && typeof history !== 'undefined' && typeof location !== 'undefined') {
		const nextHash = `#${page}`
		if (location.hash !== nextHash) history.replaceState(null, '', nextHash)
	}
	if (typeof document === 'undefined') return page
	document.body?.setAttribute('data-settings-page', page)
	document.querySelectorAll('[data-settings-page]').forEach(element => {
		const pages = String(element.dataset.settingsPage || '').split(/\s+/).filter(Boolean)
		const hidden = !pages.includes(page)
		element.hidden = hidden
		if (hidden) element.setAttribute('aria-hidden', 'true')
		else element.removeAttribute('aria-hidden')
	})
	document.querySelectorAll('[data-settings-page-target]').forEach(button => {
		const selected = normalizeSettingsPage(button.dataset.settingsPageTarget) === page
		button.classList.toggle('active', selected)
		button.classList.toggle('is-active', selected)
		if (selected) button.setAttribute('aria-current', 'page')
		else button.removeAttribute('aria-current')
	})
	return page
}

function initSettingsPageRouting() {
	if (typeof document === 'undefined') return
	document.querySelectorAll('[data-settings-page-target]').forEach(button => {
		button.addEventListener('click', () => applySettingsPage(button.dataset.settingsPageTarget))
	})
	if (typeof window !== 'undefined') {
		window.addEventListener('hashchange', () => applySettingsPage(location.hash.slice(1), { updateHash: false }))
	}
	applySettingsPage(typeof location !== 'undefined' ? location.hash.slice(1) : activeSettingsPage)
}

function replaceCount(text, count) {
	return String(text || '').replace('{count}', String(count))
}

function directoryBridgeLabel(result) {
	const bridge = result?.bridge
	if (!bridge || bridge.disabled || bridge.skipped) return t('directory_bridge_disabled')
	if (bridge.permission === false) return t('directory_bridge_pending')
	return bridge.ok === true ? t('directory_bridge_synced') : t('directory_bridge_pending')
}

function directoryScanLabel(result) {
	const text = replaceCount(
		t('directory_scan_success').replace('{bridge}', directoryBridgeLabel(result)),
		result?.index?.directories?.length || 0,
	)
	if (!result?.truncated && result?.complete !== false) return text
	return `${text} ${t('directory_scan_truncated')
		.replace('{reason}', String(result?.reason || 'budget'))
		.replace('{requests}', String(Number(result?.requests) || 0))}`
}

function selectedDirectoryCids() {
	return new Set((Push115.PathUtils?.parsePathList(
		document.getElementById('push115-save-dirs-input')?.value || '',
	) || []).map(item => item.cid))
}

function toggleDirectory(item) {
	const input = document.getElementById('push115-save-dirs-input')
	if (!input || !item?.cid) return
	const existing = Push115.PathUtils.parsePathList(input.value)
	const index = existing.findIndex(entry => entry.cid === item.cid)
	if (index >= 0) existing.splice(index, 1)
	else existing.push({ name: item.path || item.name || '', cid: item.cid })
	input.value = existing.map(entry => `${entry.name || ''}:${entry.cid}`).join('\n')
	renderSavePathSelectors(true)
	renderDirectoryIndex()
}

function renderDirectoryIndex() {
	const container = document.getElementById('push115-directory-index')
	if (!container) return
	container.textContent = ''
	const directories = Array.isArray(directoryIndex?.directories) ? directoryIndex.directories : []
	if (directories.length === 0) {
		const empty = document.createElement('div')
		empty.className = 'push115-directory-empty'
		empty.textContent = t('directory_scan_empty')
		container.appendChild(empty)
		return
	}
	const selected = selectedDirectoryCids()
	for (const item of directories.slice().sort((left, right) => String(left.path || '').localeCompare(String(right.path || ''))) ) {
		const row = document.createElement('div')
		row.className = 'push115-directory-row'
		row.style.setProperty('--push115-directory-depth', String(Math.max(0, Number(item.depth || 1) - 1)))
		const label = document.createElement('span')
		label.className = 'push115-directory-label'
		label.textContent = item.path || item.name || `CID:${item.cid}`
		const cid = document.createElement('small')
		cid.className = 'push115-directory-cid'
		cid.textContent = `CID ${item.cid}`
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'push115-directory-pick'
		button.textContent = selected.has(item.cid) ? t('directory_scan_remove') : t('directory_scan_add')
		button.addEventListener('click', () => toggleDirectory(item))
		const scan = document.createElement('button')
		scan.type = 'button'
		scan.className = 'push115-directory-pick'
		scan.textContent = t('directory_scan_children')
		scan.addEventListener('click', () => void scanDirectoryRoot(item, scan))
		row.append(label, cid, button, scan)
		container.appendChild(row)
	}
}

async function refreshDirectoryIndex() {
	try {
		const response = await sendMessage('GET_DIRECTORY_INDEX')
		directoryIndex = response.index || directoryIndex
		renderDirectoryIndex()
	} catch (error) {
		const status = document.getElementById('push115-directory-status')
		if (status) status.textContent = t('directory_scan_failed') + (error?.message || error)
	}
}

async function scanDirectories() {
	const button = document.getElementById('push115-scan-directories')
	if (button) button.disabled = true
	try {
		const response = await sendMessage('SCAN_DIRECTORIES', { roots: ['0'], maxDepth: 1 })
		directoryIndex = response.index || directoryIndex
		renderDirectoryIndex()
		const status = document.getElementById('push115-directory-status')
		if (status) status.textContent = directoryScanLabel(response)
	} catch (error) {
		const status = document.getElementById('push115-directory-status')
		if (status) status.textContent = t('directory_scan_failed') + (error?.message || error)
	} finally {
		if (button) button.disabled = false
	}
}

async function scanDirectoryRoot(item, button) {
	if (!item?.cid) return
	if (button) button.disabled = true
	try {
		const response = await sendMessage('SCAN_DIRECTORIES', { roots: [item.cid], maxDepth: 32 })
		directoryIndex = response.index || directoryIndex
		renderDirectoryIndex()
		const status = document.getElementById('push115-directory-status')
		if (status) status.textContent = directoryScanLabel(response)
	} catch (error) {
		const status = document.getElementById('push115-directory-status')
		if (status) status.textContent = t('directory_scan_failed') + (error?.message || error)
	} finally {
		if (button) button.disabled = false
	}
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
	if (typeof renderDirectoryIndex === 'function') renderDirectoryIndex()
}

function renderSavePathSelectors(preserveSiteProfiles = false, selectedCidOverride = undefined, bridgeCidOverride = undefined) {
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
	const bridgeSelect = document.getElementById('push115-bridge-target-cid')
	if (bridgeSelect && window.Push115?.PathUtils) {
		const selectedCid = Push115.PathUtils.normalizeCid(
			bridgeCidOverride ?? bridgeSelect.value ?? getConfig(CONFIG_KEYS.BRIDGE_TARGET_CID),
		) || '0'
		const options = Push115.PathUtils.buildPathOptions(listText, rootLabel)
		if (!options.some(item => item.cid === selectedCid)) options.push({ name: '', cid: selectedCid })
		bridgeSelect.textContent = ''
		for (const item of options) {
			const option = document.createElement('option')
			option.value = item.cid
			option.textContent = Push115.PathUtils.formatPathLabel(item, rootLabel)
			option.selected = item.cid === selectedCid
			bridgeSelect.appendChild(option)
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
	document.getElementById('push115-bridge-enabled').checked = getConfig(CONFIG_KEYS.BRIDGE_ENABLED) === true
	document.getElementById('push115-bridge-token').value = getConfig(CONFIG_KEYS.BRIDGE_TOKEN) || ''
	renderSavePathSelectors(false, getConfig(CONFIG_KEYS.SAVE_PATH_CID), getConfig(CONFIG_KEYS.BRIDGE_TARGET_CID))
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
		[CONFIG_KEYS.BRIDGE_ENABLED]: document.getElementById('push115-bridge-enabled').checked,
		[CONFIG_KEYS.BRIDGE_TOKEN]: document.getElementById('push115-bridge-token').value.trim(),
		[CONFIG_KEYS.BRIDGE_TARGET_CID]: normalizeCid(document.getElementById('push115-bridge-target-cid').value),
	}
}

function showSettingsStatus(type, message) {
	const area = document.getElementById('push115-settings-status')
	area.className = `push115-status ${type || ''}`
	area.textContent = message || ''
}


async function requestContentScriptPermissions(siteProfiles, extraOrigins = []) {
	const missingOrigins = []
	for (const [siteId, definition] of Object.entries(Push115.Config.SITE_DEFINITIONS)) {
		if (!siteProfiles[siteId]?.enabled) continue
		const origins = [...definition.matches]
		let granted = await chrome.permissions.contains({ origins })
		// Chrome may report the broader optional <all_urls> grant rather than
		// each dedicated host pattern in this check. Treat it as covering the
		// site before prompting again during a settings save.
		if (!granted && !origins.includes('<all_urls>')) {
			granted = await chrome.permissions.contains({ origins: ['<all_urls>'] })
		}
		if (!granted) missingOrigins.push(...origins)
	}
	missingOrigins.push(...extraOrigins)
	const uniqueOrigins = [...new Set(missingOrigins)]
	if (uniqueOrigins.length === 0) return true
	const granted = await chrome.permissions.request({ origins: uniqueOrigins })
	if (!granted) {
		if (extraOrigins.length > 0) throw new Error(t('bridge_permission_denied'))
		throw new Error(t('permission_denied'))
	}
	return true
}

async function requestBridgePermission(nextConfig) {
	if (nextConfig[CONFIG_KEYS.BRIDGE_ENABLED] !== true) return []
	const origin = Push115.Config.BRIDGE_HOST_PERMISSION
	if (!chrome.permissions?.contains || !chrome.permissions?.request) return []
	const granted = await chrome.permissions.contains({ origins: [origin] })
	return granted ? [] : [origin]
}

async function ensureBridgeHostPermission() {
	const origin = Push115.Config.BRIDGE_HOST_PERMISSION
	if (!chrome.permissions?.contains || !chrome.permissions?.request) return true
	if (await chrome.permissions.contains({ origins: [origin] })) return true
	if (await chrome.permissions.request({ origins: [origin] })) return true
	throw new Error(t('bridge_permission_denied'))
}

function renderBridgeBootstrapStatus(status) {
	const element = document.getElementById('push115-bridge-bootstrap-status')
	if (!element) return
	if (status?.connecting === true) {
		element.textContent = t('bridge_status_connecting')
		return
	}
	if (!status) {
		element.textContent = t('bridge_status_unavailable')
		return
	}
	element.textContent = status.connected === true || status.paired === true
		? t('bridge_status_connected')
		: t('bridge_status_unavailable')
}

function bridgeDirectorySyncMessage(value) {
	const sync = value?.directorySync && typeof value.directorySync === 'object'
		? value.directorySync
		: value
	if (!sync || typeof sync !== 'object') return null
	if (sync.skipped === true && sync.reason === 'empty') {
		return { type: '', text: t('bridge_sync_empty') }
	}
	if (sync.skipped === true && sync.reason === 'directory_index_sync_failed') {
		return { type: 'error', text: t('bridge_sync_failed') + String(sync.error || 'unknown error') }
	}
	if (sync.bridge?.permission === false) {
		return { type: 'error', text: t('bridge_sync_failed') + t('bridge_permission_denied') }
	}
	if (sync.bridge?.disabled === true || sync.disabled === true) {
		return { type: '', text: t('bridge_sync_pending') }
	}
	if (sync.bridge?.ok === false) {
		return { type: 'error', text: t('bridge_sync_failed') + String(sync.bridge.error || 'unknown error') }
	}
	if (sync.bridge?.ok === true || sync.success === true) {
		const count = Array.isArray(sync.index?.directories)
			? sync.index.directories.length
			: Number(sync.result?.directoryCount) || 0
		const revision = Number(sync.index?.revision ?? sync.revision ?? 0) || 0
		return {
			type: 'success',
			text: t('bridge_sync_success').replace('{count}', String(count)).replace('{revision}', String(revision)),
		}
	}
	return null
}

async function syncDirectoryFromOptions() {
	return sendMessage('SYNC_DIRECTORY_INDEX')
}

function renderTelegramStatus(status) {
	const statusText = document.getElementById('push115-telegram-status-text')
	const botName = document.getElementById('push115-telegram-bot-name')
	const ownerStatus = document.getElementById('push115-telegram-owner-status')
	if (!status) {
		if (statusText) statusText.textContent = t('telegram_status_unavailable')
		if (botName) botName.textContent = t('telegram_bot_unknown')
		if (ownerStatus) ownerStatus.textContent = t('telegram_owner_unbound')
		return
	}
	if (statusText) {
		statusText.textContent = status.enabled
			? t('telegram_status_enabled')
			: (status.configured ? t('telegram_status_disabled') : t('telegram_not_configured'))
	}
	if (botName) botName.textContent = status.botUsername ? `@${status.botUsername}` : t('telegram_bot_unknown')
	if (ownerStatus) ownerStatus.textContent = status.ownerBound ? t('telegram_owner_bound') : t('telegram_owner_unbound')
}

async function refreshTelegramStatus() {
	const token = String((await chrome.storage.local.get(CONFIG_KEYS.BRIDGE_TOKEN))[CONFIG_KEYS.BRIDGE_TOKEN] || '').trim()
	if (!token) {
		renderTelegramStatus(null)
		return null
	}
	try {
		const status = await Push115.Background.BridgeClient.getTelegramStatus(token)
		renderTelegramStatus(status)
		return status
	} catch (error) {
		renderTelegramStatus(null)
		const message = document.getElementById('push115-telegram-status-message')
		if (message) {
			message.className = 'push115-status error'
			message.textContent = t('telegram_action_failed') + (error?.message || error)
		}
		return null
	}
}

async function refreshBridgeOnboarding(requestPermission = false) {
	try {
		if (requestPermission) await ensureBridgeHostPermission()
		const stored = await chrome.storage.local.get([CONFIG_KEYS.BRIDGE_TOKEN, CONFIG_KEYS.BRIDGE_ENABLED])
		const token = String(stored[CONFIG_KEYS.BRIDGE_TOKEN] || '').trim()
		let status
		if (!token && stored[CONFIG_KEYS.BRIDGE_ENABLED] !== true) {
			renderBridgeBootstrapStatus(null)
			await refreshTelegramStatus()
			return null
		}
		if (!token) {
			const hasPermission = !chrome.permissions?.contains
				|| await chrome.permissions.contains({ origins: [Push115.Config.BRIDGE_HOST_PERMISSION] })
			if (!hasPermission) {
				renderBridgeBootstrapStatus(null)
				await refreshTelegramStatus()
				return null
			}
			renderBridgeBootstrapStatus({ connecting: true })
			status = await Push115.Background.BridgeClient.connectBridge()
			const connectionMessage = bridgeDirectorySyncMessage(status)
			const connectionStatus = document.getElementById('push115-bridge-connect-status')
			if (connectionStatus && connectionMessage) {
				connectionStatus.className = `push115-status ${connectionMessage.type}`
				connectionStatus.textContent = connectionMessage.text
			}
			const values = await chrome.storage.local.get([
				CONFIG_KEYS.BRIDGE_TOKEN,
				CONFIG_KEYS.BRIDGE_ENABLED,
				CONFIG_KEYS.BRIDGE_PAIRED,
			])
			configCache = { ...configCache, ...values }
			fillForm()
		} else {
			status = await Push115.Background.BridgeClient.bootstrapStatus()
			if (status?.connected === true || status?.paired === true) {
				try {
					const sync = await syncDirectoryFromOptions()
					const syncMessage = bridgeDirectorySyncMessage(sync)
					const message = document.getElementById('push115-bridge-connect-status')
					if (message && syncMessage) {
						message.className = `push115-status ${syncMessage.type}`
						message.textContent = syncMessage.text
					}
				} catch (error) {
					const message = document.getElementById('push115-bridge-connect-status')
					if (message) {
						message.className = 'push115-status error'
						message.textContent = t('bridge_sync_failed') + (error?.message || error)
					}
				}
			}
		}
		renderBridgeBootstrapStatus(status)
		await refreshTelegramStatus()
		return status
	} catch (error) {
		renderBridgeBootstrapStatus(null)
		const message = document.getElementById('push115-bridge-connect-status')
		if (message) {
			message.className = 'push115-status'
			message.textContent = ''
		}
		renderTelegramStatus(null)
		return null
	}
}

async function connectBridgeFromOptions() {
	const button = document.getElementById('push115-bridge-refresh')
	const status = document.getElementById('push115-bridge-connect-status')
	if (button) button.disabled = true
	try {
		if (status) {
			status.className = 'push115-status'
			status.textContent = ''
		}
		renderBridgeBootstrapStatus({ connecting: true })
		await ensureBridgeHostPermission()
		const connection = await Push115.Background.BridgeClient.connectBridge()
		const values = await chrome.storage.local.get([CONFIG_KEYS.BRIDGE_TOKEN, CONFIG_KEYS.BRIDGE_ENABLED, CONFIG_KEYS.BRIDGE_PAIRED])
		configCache = { ...configCache, ...values }
		fillForm()
		const syncMessage = bridgeDirectorySyncMessage(connection)
		if (status) {
			status.className = `push115-status ${syncMessage?.type || 'success'}`
			status.textContent = syncMessage?.text || t('bridge_connect_success')
		}
		renderBridgeBootstrapStatus({ connected: true, paired: true })
		await refreshDirectoryIndex()
		await refreshTelegramStatus()
	} catch (error) {
		if (status) {
			status.className = 'push115-status error'
			status.textContent = t('bridge_connect_failed') + (error?.message || error)
		}
		renderBridgeBootstrapStatus(null)
	} finally {
		if (button) button.disabled = false
	}
}

async function updateTelegramFromOptions(action, details = {}) {
	const button = document.getElementById(`push115-telegram-${action}`)
	const message = document.getElementById('push115-telegram-status-message')
	if (button) button.disabled = true
	try {
		const clientAction = Push115.Background.BridgeClient[action + 'Telegram']
		if (typeof clientAction !== 'function') throw new Error(t('telegram_action_failed') + action)
		// start/stop/restart use the already validated token stored by Bridge.
		// Passing the wrapper's default `{}` as the first positional argument
		// would otherwise turn it into a literal Bot Token or Bearer token.
		const status = action === 'configure'
			? await clientAction(details)
			: await clientAction()
		renderTelegramStatus(status)
		if (message) {
			message.className = 'push115-status success'
			message.textContent = t('telegram_action_success')
		}
		return status
	} catch (error) {
		if (message) {
			message.className = 'push115-status error'
			message.textContent = t('telegram_action_failed') + (error?.message || error)
		}
		return null
	} finally {
		if (button) button.disabled = false
	}
}

async function configureTelegramFromOptions() {
	const input = document.getElementById('push115-telegram-token')
	const token = String(input?.value || '').trim()
	if (!token) {
		const message = document.getElementById('push115-telegram-status-message')
		if (message) {
			message.className = 'push115-status error'
			message.textContent = t('telegram_token_hint')
		}
		return
	}
	const button = document.getElementById('push115-telegram-configure')
	const message = document.getElementById('push115-telegram-status-message')
	if (button) button.disabled = true
	try {
		const status = await Push115.Background.BridgeClient.configureTelegram({ enabled: true, botToken: token })
		if (input) input.value = ''
		renderTelegramStatus(status)
		if (message) {
			message.className = 'push115-status success'
			message.textContent = t('telegram_action_success')
		}
	} catch (error) {
		if (message) {
			message.className = 'push115-status error'
			message.textContent = t('telegram_action_failed') + (error?.message || error)
		}
	} finally {
		if (button) button.disabled = false
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
		const bridgeOrigins = await requestBridgePermission(nextConfig)
		await requestContentScriptPermissions(nextConfig[CONFIG_KEYS.SITE_PROFILES], bridgeOrigins)
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
	document.getElementById('push115-bridge-refresh')?.addEventListener('click', () => void connectBridgeFromOptions())
	document.getElementById('push115-telegram-refresh')?.addEventListener('click', () => void refreshTelegramStatus())
	document.getElementById('push115-telegram-configure')?.addEventListener('click', () => void configureTelegramFromOptions())
	document.getElementById('push115-telegram-start')?.addEventListener('click', () => void updateTelegramFromOptions('start'))
	document.getElementById('push115-telegram-stop')?.addEventListener('click', () => void updateTelegramFromOptions('stop'))
	document.getElementById('push115-telegram-restart')?.addEventListener('click', () => void updateTelegramFromOptions('restart'))
	document.getElementById('push115-save-dirs-input').addEventListener('change', () => renderSavePathSelectors(true))
	document.getElementById('push115-scan-directories').addEventListener('click', () => void scanDirectories())
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
		if (changes[DIRECTORY_INDEX_KEY]) {
			directoryIndex = changes[DIRECTORY_INDEX_KEY].newValue || directoryIndex
			renderDirectoryIndex()
		}
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
	initSettingsPageRouting()
	applyTheme(getConfig(CONFIG_KEYS.THEME))
	applyLocale()
	fillForm()
	bindEvents()
	void refreshBridgeOnboarding(false)
	await refreshDirectoryIndex()
	await Push115.OptionsTasks.refresh()
	setInterval(Push115.OptionsTasks.refresh, 5000)
}

void init()
