importScripts(
	'../shared/config.js',
	'../shared/download-intent.js',
	'../shared/anime-series.js',
	'../shared/file-rules.js',
	'api/auth.js',
	'api/client.js',
	'api/offline.js',
	'api/files.js',
	'tasks/folders.js',
	'tasks/anime-library.js',
	'tasks/store.js',
	'processors/cleanup.js',
	'processors/generic.js',
	'processors/anime.js',
	'processors/jav.js',
	'tasks/monitor.js',
	'content-scripts.js',
	'router.js',
)

const background = globalThis.Push115.Background
const configKeys = globalThis.Push115.Config.STORAGE_KEYS

async function initialize() {
	await globalThis.Push115.Config.migrateConfig()
	await background.ContentScripts.sync()
	await background.TaskMonitor.ensureAlarm()
	void background.TaskMonitor.processPending()
}

background.Router.listen()
chrome.runtime.onInstalled.addListener(() => void initialize())
chrome.runtime.onStartup.addListener(() => void initialize())
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === background.TaskMonitor.ALARM_NAME) void background.TaskMonitor.processPending()
})
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return
	if (changes[configKeys.AUTO_DETECT] || changes[configKeys.SITE_PROFILES]) void background.ContentScripts.sync()
})

void initialize()
