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
	'directory-index.js',
	'tasks/anime-library.js',
	'tasks/store.js',
	'processors/cleanup.js',
	'processors/generic.js',
	'processors/anime.js',
	'processors/jav.js',
	'tasks/monitor.js',
	'content-scripts.js',
	'router.js',
	'bridge-client.js',
)

const background = globalThis.Push115.Background
const configKeys = globalThis.Push115.Config.STORAGE_KEYS

async function initialize() {
	await globalThis.Push115.Config.migrateConfig()
	await background.ContentScripts.syncAndInject()
	await background.TaskMonitor.ensureAlarm()
	await background.BridgeClient.syncConfig()
	void background.DirectoryIndex.syncStored()
	void background.TaskMonitor.processPending()
	void background.BridgeClient.processPending()
}

background.Router.listen()
chrome.runtime.onInstalled.addListener(() => void initialize())
chrome.runtime.onStartup.addListener(() => void initialize())
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === background.TaskMonitor.ALARM_NAME) void background.TaskMonitor.processPending()
	if (alarm.name === background.BridgeClient.ALARM_NAME) void background.BridgeClient.processPending()
})
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return
	if (changes[configKeys.AUTO_DETECT] || changes[configKeys.SITE_PROFILES]) void background.ContentScripts.sync()
	if (changes[configKeys.SITE_PROFILES]
		|| changes[configKeys.SAVE_PATH_LIST]
		|| changes[configKeys.SAVE_PATH_CID]) {
		void background.DirectoryIndex.syncStored()
	}
	if (changes[configKeys.BRIDGE_ENABLED] || changes[configKeys.BRIDGE_TOKEN] || changes[configKeys.BRIDGE_TARGET_CID]) {
		void background.BridgeClient.syncConfig()
		if (changes[configKeys.BRIDGE_ENABLED]?.newValue === true || changes[configKeys.BRIDGE_TOKEN]?.newValue) {
			void background.DirectoryIndex.syncStored()
		}
		if (changes[configKeys.BRIDGE_ENABLED]?.newValue === true || changes[configKeys.BRIDGE_TOKEN]?.newValue) {
			void background.BridgeClient.processPending()
		}
	}
})

void initialize()
