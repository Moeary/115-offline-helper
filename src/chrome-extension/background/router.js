;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const { STORAGE_KEYS } = global.Push115.Config
	const submissions = new Map()
	let submissionGeneration = 0

	function assertSubmissionGeneration(generation) {
		if (generation !== submissionGeneration) throw new Error('本地任务状态已完全重置，请重新提交')
	}

	function submissionJobId(result, intent) {
		return String(
			intent.jobId || intent.metadata?.bridgeJobId
			|| result?.task_id || result?.taskId || result?.job_id || result?.jobId || result?.id
			|| result?.info_hash || result?.infoHash || result?.hash || intent.metadata?.btih || '',
		).trim()
	}

	function snapshotItem(item) {
		return {
			fid: String(item?.fid ?? item?.file_id ?? item?.fileId ?? '').trim(),
			cid: String(item?.cid ?? item?.dir_id ?? item?.dirId ?? '').trim(),
			name: String(item?.n || item?.name || '').trim(),
			size: item?.size ?? item?.s ?? item?.file_size ?? item?.fileSize ?? '',
			hash: String(item?.hash || item?.ed2kHash || item?.file_hash || item?.content_hash || '').trim().toLowerCase(),
			isFile: Boolean(item?.sha),
		}
	}

	async function captureBeforeSnapshot(intent) {
		// ED2K + JAV is the direct-file path.  Capture the complete, breadcrumb
		// validated listing before submitting so a later file with the same name
		// cannot be mistaken for this task's result.
		if (intent.processorProfile !== 'jav' || intent.linkType !== 'ed2k') return null
		const folders = background.Folders
		if (!folders?.read) return null
		const cid = String(intent.savePathCid || '0').trim()
		const listing = await folders.read(cid)
		return {
			cid,
			capturedAt: Date.now(),
			items: (Array.isArray(listing?.items) ? listing.items : []).map(snapshotItem),
		}
	}

	async function submitIntent(rawIntent) {
		const generation = submissionGeneration
		const intent = global.Push115.DownloadIntent.create(rawIntent)
		const bridgeJobId = String(intent.jobId || intent.metadata?.bridgeJobId || '').trim().toLowerCase()
		const key = bridgeJobId ? `bridge-job:${bridgeJobId}` : global.Push115.DownloadIntent.dedupeKey(intent.url)
		const previous = submissions.get(key) || Promise.resolve()
		const work = previous.catch(() => {}).then(() => submitNormalizedIntent(intent, generation))
		submissions.set(key, work)
		try { return await work } finally { if (submissions.get(key) === work) submissions.delete(key) }
	}

	async function submitNormalizedIntent(intent, generation = submissionGeneration) {
		assertSubmissionGeneration(generation)
		const bridgeJobId = String(intent.jobId || intent.metadata?.bridgeJobId || '').trim().toLowerCase()
		if (bridgeJobId && intent.metadata?.skipSubmitted !== false) {
			const tasks = await background.TaskStore.read()
			const existing = tasks.find(task => String(task.jobId || task.metadata?.bridgeJobId || '').trim().toLowerCase() === bridgeJobId
				&& task.status !== 'failed')
			if (existing) return { duplicate: true, task: existing, message: '该桥接任务已登记；可在任务日志中重试' }
		}
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
		const beforeSnapshot = await captureBeforeSnapshot(intent)
		assertSubmissionGeneration(generation)
		const result = await background.OfflineApi.addTask(intent.url, intent.savePathCid)
		assertSubmissionGeneration(generation)
		const jobId = submissionJobId(result, intent)
		const config = await chrome.storage.local.get([
			STORAGE_KEYS.AUTO_DELETE_SMALL,
			STORAGE_KEYS.AUTO_ORGANIZE,
		])
		const isAnimeBatch = global.Push115.AnimeSeries.needsFlatten(intent)
		const monitor = intent.monitorDownload === true || intent.metadata?.monitorDownload === true
			? true
			: isAnimeBatch
			? true
			: intent.processorProfile === 'jav'
			? config[STORAGE_KEYS.AUTO_DELETE_SMALL] === true || config[STORAGE_KEYS.AUTO_ORGANIZE] === true
			: config[STORAGE_KEYS.AUTO_DELETE_SMALL] === true
		const task = await background.TaskStore.queue({
			intent: { ...intent, jobId },
			jobId,
			remoteId: result.info_hash || result.hash || result.task_id || intent.metadata.btih,
			name: result.name || '',
			monitor,
			monitorDownload: intent.monitorDownload === true || intent.metadata?.monitorDownload === true,
			beforeSnapshot,
		})
		assertSubmissionGeneration(generation)
		if (isBoundAnime) await background.AnimeLibrary.recordSubmission(intent, task.taskId)
		assertSubmissionGeneration(generation)
		return { result, task }
	}

	async function recordIntents(rawIntents = []) {
		const list = Array.isArray(rawIntents) ? rawIntents : []
		const entries = []
		const seen = new Set()
		for (const rawIntent of list) {
			const intent = global.Push115.DownloadIntent.create(rawIntent)
			const key = global.Push115.DownloadIntent.dedupeKey(intent.url)
			if (seen.has(key)) {
				entries.push({ key, duplicate: true, intent })
				continue
			}
			seen.add(key)
			entries.push({ key, intent, ...(await background.TaskStore.record(intent)) })
		}
		return {
			recorded: entries.filter(entry => !entry.duplicate).length,
			duplicate: entries.filter(entry => entry.duplicate).length,
			entries,
		}
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
					case 'RECORD_INTENTS':
						return { success: true, ...await recordIntents(details.intents) }
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
					case 'INJECT_ACTIVE_TAB':
						return { success: true, ...await background.ContentScripts.injectActiveTab() }
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

	background.Router = { listen, submitIntent, recordIntents }
})(globalThis)
