;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const { STORAGE_KEYS } = global.Push115.Config

	async function submitIntent(rawIntent) {
		const intent = global.Push115.DownloadIntent.create(rawIntent)
		const result = await background.OfflineApi.addTask(intent.url, intent.savePathCid)
		const config = await chrome.storage.local.get([
			STORAGE_KEYS.AUTO_DELETE_SMALL,
			STORAGE_KEYS.AUTO_ORGANIZE,
		])
		const monitor = intent.processorProfile === 'anime_mikan'
			? true
			: intent.processorProfile === 'jav'
			? config[STORAGE_KEYS.AUTO_DELETE_SMALL] === true || config[STORAGE_KEYS.AUTO_ORGANIZE] === true
			: config[STORAGE_KEYS.AUTO_DELETE_SMALL] === true
		const task = await background.TaskStore.queue({
			intent,
			remoteId: result.info_hash || result.hash || result.task_id || intent.metadata.btih,
			name: result.name || '',
			monitor,
		})
		return { result, task }
	}

	function notify(details = {}) {
		if (!chrome.notifications?.create) return
		chrome.notifications.create({
			type: 'basic', iconUrl: 'icons/icon48.png',
			title: details.title || '115 Offline Helper', message: details.message || '',
		})
	}

	function listen() {
		chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
			const action = request?.action
			const details = request?.details || {}
			if (action === 'NOTIFY') {
				notify(details)
				return undefined
			}

			const work = (async () => {
				switch (action) {
					case 'API_REQUEST': {
						const response = await background.Client.request(details)
						return { success: true, ...response }
					}
					case 'GET_COOKIE':
						return { success: true, cookie: await background.Auth.getCookie() }
					case 'SET_COOKIE':
						return { success: true, cookie: await background.Auth.persistCookieToStorageAndJar(details.cookie) }
					case 'SUBMIT_INTENT':
						return { success: true, ...await submitIntent(details.intent || details) }
					case 'QUEUE_TASK':
						return { success: true, task: await background.TaskStore.queue(details) }
					case 'GET_TASKS':
						return { success: true, tasks: await background.TaskStore.read() }
					case 'CLEAR_LOGS':
						return { success: true, ...await background.TaskStore.clearLogs() }
					case 'RETRY_TASK':
						return { success: true, task: await background.TaskStore.retry(details.taskId) }
					case 'REGISTER_CONTENT_SCRIPTS':
					case 'SYNC_CONTENT_SCRIPTS':
						await background.ContentScripts.syncAndInject()
						return { success: true }
					case 'UNREGISTER_CONTENT_SCRIPTS':
						await background.ContentScripts.unregister()
						return { success: true }
					default:
						return null
				}
			})()

			work.then(response => {
				if (response) sendResponse(response)
			}).catch(error => {
				console.error(`[BG] ${action || 'UNKNOWN'} failed:`, error)
				sendResponse({ success: false, error: error?.message || String(error) })
			})
			return true
		})
	}

	background.Router = { listen, submitIntent }
})(globalThis)
