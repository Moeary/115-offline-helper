;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const { STORAGE_KEYS } = global.Push115.Config
	const submissions = new Map()
	let submissionGeneration = 0

	function assertSubmissionGeneration(generation) {
		if (generation !== submissionGeneration) throw new Error('本地任务状态已完全重置，请重新提交')
	}

	async function submitIntent(rawIntent) {
		const generation = submissionGeneration
		const intent = global.Push115.DownloadIntent.create(rawIntent)
		const key = global.Push115.DownloadIntent.dedupeKey(intent.url)
		const previous = submissions.get(key) || Promise.resolve()
		const work = previous.catch(() => {}).then(() => submitNormalizedIntent(intent, generation))
		submissions.set(key, work)
		try { return await work } finally { if (submissions.get(key) === work) submissions.delete(key) }
	}

	async function submitNormalizedIntent(intent, generation = submissionGeneration) {
		assertSubmissionGeneration(generation)
		const isBoundAnime = intent.processorProfile === 'anime' && Boolean(intent.metadata.animeTarget)
		if (isBoundAnime) {
			const binding = await background.AnimeLibrary.validateTarget(intent)
			assertSubmissionGeneration(generation)
			const key = global.Push115.DownloadIntent.dedupeKey(intent.url)
			const receipt = binding.submissions && typeof binding.submissions === 'object' ? binding.submissions[key] : null
			const tasks = await background.TaskStore.read()
			const existing = tasks.find(task => task.savePathCid === intent.savePathCid && global.Push115.DownloadIntent.dedupeKey(task.url || task.magnet) === key)
			if (intent.metadata.skipSubmitted !== false && ((receipt?.cid === intent.savePathCid && existing?.status !== 'failed') || (existing && ['waiting', 'processing', 'completed'].includes(existing.status)))) {
				return { duplicate: true, message: '本番已提交过此磁链；可在任务日志中重试' }
			}
		}
		const result = await background.OfflineApi.addTask(intent.url, intent.savePathCid)
		assertSubmissionGeneration(generation)
		const config = await chrome.storage.local.get([
			STORAGE_KEYS.AUTO_DELETE_SMALL,
			STORAGE_KEYS.AUTO_ORGANIZE,
		])
		const isAnimeBatch = global.Push115.AnimeSeries.needsFlatten(intent)
		const monitor = isAnimeBatch
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
		assertSubmissionGeneration(generation)
		if (isBoundAnime) await background.AnimeLibrary.recordSubmission(intent, task.taskId)
		assertSubmissionGeneration(generation)
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
					case 'GET_ANIME_SERIES':
						return { success: true, binding: await background.AnimeLibrary.get(details.key) }
					case 'PREPARE_ANIME_SERIES':
						return { success: true, target: await background.AnimeLibrary.prepare(details) }
					case 'CLEAR_LOGS':
						return { success: true, ...await background.TaskStore.clearLogs() }
					case 'RESET_RUNTIME': {
						submissionGeneration += 1
						submissions.clear()
						const [tasks, series] = await Promise.all([
							background.TaskStore.resetRuntime(),
							background.AnimeLibrary.reset(),
						])
						return {
							success: true,
							tasksCleared: tasks?.tasksCleared || 0,
							seriesCleared: series?.seriesCleared || 0,
						}
					}
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
