;(function (global) {
	'use strict'
	const { STORAGE_KEYS, normalizeCid, normalizeProcessorProfile } = global.Push115.Config
	const intentApi = global.Push115.DownloadIntent
	let writes = Promise.resolve()
	// A reset invalidates task objects that were already loaded by a monitor or
	// submission before the user pressed the reset button.  WeakMap keeps this
	// generation marker out of the persisted task schema.
	let resetGeneration = 0
	const taskGenerations = new WeakMap()

	function rememberTask(task) {
		if (task && typeof task === 'object' && !taskGenerations.has(task)) taskGenerations.set(task, resetGeneration)
		return task
	}

	function rememberTasks(tasks) {
		for (const task of tasks) rememberTask(task)
		return tasks
	}

	function serialized(work) {
		const result = writes.catch(() => {}).then(work)
		writes = result
		return result
	}

	function makeTaskId() {
		if (global.crypto?.randomUUID) return global.crypto.randomUUID()
		return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`
	}

	function taskIsActive(task) {
		return ['waiting', 'processing'].includes(task?.status)
	}

	function appendLog(task, message) {
		const text = String(message || '').trim()
		if (!text) return
		const logs = Array.isArray(task.logs) ? task.logs : []
		logs.push({ at: Date.now(), message: text })
		task.logs = logs.slice(-60)
	}

	async function read() {
		const data = await chrome.storage.local.get(STORAGE_KEYS.TASKS)
		const records = Array.isArray(data[STORAGE_KEYS.TASKS]) ? data[STORAGE_KEYS.TASKS] : []
		return rememberTasks(records.map(migrateTask))
	}

	function numberOrText(value) {
		const text = String(value ?? '').replace(/\s+/g, '').trim()
		if (!/^\d+$/.test(text)) return ''
		const number = Number(text)
		return Number.isSafeInteger(number) ? number : text
	}

	function getIntentLink(url) {
		try { return intentApi.parseDownloadLink?.(url) || null } catch (error) { return null }
	}

	function normalizeLinkType(value, parsed = null) {
		const candidate = String(value || '').trim().toLowerCase()
		return ['magnet', 'ed2k'].includes(candidate) ? candidate : String(parsed?.linkType || '').trim().toLowerCase()
	}

	function migrateTask(task) {
		if (!task || typeof task !== 'object') return task
		const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
			? task.metadata
			: {}
		const link = getIntentLink(task.url || task.magnet)
		const expectedName = String(task.expectedName || metadata.expectedName || link?.fileName || task.remoteName || '').trim()
		const expectedSize = task.expectedSize !== undefined && task.expectedSize !== null && task.expectedSize !== ''
			? numberOrText(task.expectedSize)
			: (link?.size || numberOrText(metadata.expectedSize || metadata.ed2kSize))
		const expectedHash = String(task.expectedHash || metadata.expectedHash || link?.hash || metadata.ed2kHash || '').trim().toLowerCase()
		const linkType = normalizeLinkType(task.linkType || metadata.linkType, link)
		const jobId = String(task.jobId || metadata.bridgeJobId || task.remoteId || '').trim()
		const monitorDownload = task.monitorDownload === true || metadata.monitorDownload === true
		if (task.linkType === undefined && linkType) task.linkType = linkType
		if (task.expectedName === undefined && expectedName) task.expectedName = expectedName
		if (task.expectedSize === undefined && expectedSize !== '') task.expectedSize = expectedSize
		if (task.expectedHash === undefined && expectedHash) task.expectedHash = expectedHash
		if (task.jobId === undefined && jobId) task.jobId = jobId
		if (monitorDownload && task.monitorDownload !== true) task.monitorDownload = true
		if (task.code === undefined || !task.code) {
			const code = intentApi.extractVideoCode?.([metadata.pageCode, expectedName, task.remoteName, task.title]) || ''
			if (code) task.code = code
		}
		return task
	}

	async function clearLogsNow() {
		const records = await read()
		// Keep waiting/processing tasks intact so clearing history never cancels
		// persistent downloads. Completed, failed, and recorded task entries are
		// historical log records and can be removed safely.
		const active = records.filter(taskIsActive)
		const removed = records.length - active.length
		if (removed > 0) await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: active })
		return { removed, retained: active.length }
	}

	async function persistNow(task) {
		const tasks = await read()
		const index = tasks.findIndex(item => item.taskId === task.taskId)
		if (index >= 0) tasks[index] = task
		else tasks.unshift(task)
		const active = tasks.filter(taskIsActive).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
		const history = tasks.filter(item => !taskIsActive(item)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
		await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: [...active, ...history.slice(0, 50)] })
		Promise.resolve(chrome.runtime.sendMessage({ action: 'TASK_UPDATED', task })).catch(() => {})
	}

	function persist(task) {
		if (!task || typeof task !== 'object') return Promise.resolve({ skipped: true })
		const generation = rememberTask(task) && taskGenerations.get(task)
		return serialized(() => {
			if (generation !== resetGeneration) return { skipped: true, reset: true }
			return persistNow(task)
		})
	}

	const clearLogs = () => serialized(clearLogsNow)

	async function resetRuntimeNow() {
		const records = await read()
		const tasksCleared = records.length
		// Keep the storage shape stable for older Chrome/test shims that do not
		// implement storage.local.remove.  This clears every local task record;
		// the router clears the independent Anime library in the same operation.
		await chrome.storage.local.set({
			[STORAGE_KEYS.TASKS]: [],
			[STORAGE_KEYS.TASK_MONITOR_CURSOR]: '',
		})
		return { tasksCleared }
	}

	function resetRuntime() {
		resetGeneration += 1
		return serialized(resetRuntimeNow)
	}

	function normalizeLegacyIntent(details = {}) {
		const input = details.intent && typeof details.intent === 'object' ? details.intent : details
		const url = String(input.url || input.magnet || '').trim()
		const metadata = input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {}
		const link = getIntentLink(url)
		const expectedName = String(input.expectedName || metadata.expectedName || link?.fileName || input.name || intentApi.extractDisplayName(url) || '').trim()
		const expectedSize = input.expectedSize !== undefined && input.expectedSize !== null && input.expectedSize !== ''
			? numberOrText(input.expectedSize)
			: (link?.size || numberOrText(metadata.expectedSize || metadata.ed2kSize))
		const expectedHash = String(input.expectedHash || metadata.expectedHash || link?.hash || metadata.ed2kHash || '').trim().toLowerCase()
		const linkType = normalizeLinkType(input.linkType || metadata.linkType, link)
		const pageCode = intentApi.normalizeCode(metadata.pageCode)
		const code = pageCode || intentApi.extractVideoCode?.([input.code, expectedName, input.name, input.title]) || ''
		const jobId = String(input.jobId || metadata.bridgeJobId || '').trim()
		const monitorDownload = input.monitorDownload === true || metadata.monitorDownload === true
		const explicitProcessor = input.processorProfile
		const processorProfile = explicitProcessor
			? normalizeProcessorProfile(explicitProcessor, input.mediaType === 'anime' ? 'anime' : 'generic')
			: (code ? 'jav' : input.mediaType === 'anime' ? 'anime' : 'generic')
		return {
			sourceSite: String(input.sourceSite || input.source || 'generic').trim().toLowerCase() || 'generic',
			mediaType: ['generic', 'jav', 'anime'].includes(input.mediaType) ? input.mediaType : 'generic',
			url,
			title: String(input.title || expectedName || '').trim(),
			code,
			jobId,
			monitorDownload,
			linkType,
			expectedName,
			expectedSize,
			expectedHash,
			metadata: {
				...metadata,
				btih: metadata.btih || intentApi.extractBtih(url),
				...(linkType ? { linkType } : {}),
				...(expectedName ? { expectedName } : {}),
				...(expectedSize !== '' ? { expectedSize } : {}),
				...(expectedHash ? { expectedHash } : {}),
				...(jobId && !metadata.bridgeJobId ? { bridgeJobId: jobId } : {}),
				...(monitorDownload ? { monitorDownload: true } : {}),
			},
			savePathCid: normalizeCid(input.savePathCid, '0'),
			processorProfile,
		}
	}

	async function queue(details = {}) {
		const now = Date.now()
		const intent = normalizeLegacyIntent(details)
		const remoteId = String(
			details.remoteId || details.info_hash || details.id || intent.metadata.btih || '',
		).trim().toLowerCase()
		const jobId = String(details.jobId || intent.jobId || intent.metadata.bridgeJobId || remoteId || '').trim()
		const remoteName = String(details.name || intent.expectedName || intentApi.extractDisplayName(intent.url) || '').trim()
		// Keep the legacy QUEUE_TASK contract: callers that omit monitor asked for
		// persistent monitoring. New SUBMIT_INTENT callers pass an explicit bool.
		const monitor = intent.monitorDownload === true || details.monitorDownload === true
			|| (details.monitor === undefined ? true : details.monitor === true)
		const records = await read()
		const incomingJobId = String(intent.jobId || intent.metadata.bridgeJobId || '').trim().toLowerCase()
		const existing = records.find(task => {
			if (!taskIsActive(task)) return false
			const taskJobId = String(task.jobId || task.metadata?.bridgeJobId || '').trim().toLowerCase()
			// A bridge job is the stable unit of work. Never merge a different
			// bridge job merely because it happens to carry the same URL/hash.
			if (incomingJobId && taskJobId && incomingJobId !== taskJobId) return false
			return (incomingJobId && taskJobId && incomingJobId === taskJobId)
				|| (remoteId && String(task.remoteId || '').toLowerCase() === remoteId)
				|| (intent.url && (task.url === intent.url || task.magnet === intent.url))
		})
		const task = existing || { taskId: makeTaskId(), createdAt: now, attempts: 0, logs: [] }
		rememberTask(task)

		Object.assign(task, {
			remoteId: remoteId || task.remoteId || '',
			jobId: jobId || task.jobId || task.remoteId || '',
			remoteName: remoteName || task.remoteName || '',
			url: intent.url || task.url || task.magnet || '',
			magnet: intent.url || task.magnet || '',
			sourceSite: intent.sourceSite,
			source: intent.sourceSite,
			mediaType: intent.mediaType,
			title: intent.title || task.title || '',
			code: intent.code || task.code || '',
			linkType: intent.linkType || task.linkType || '',
			expectedName: intent.expectedName || task.expectedName || '',
			expectedSize: intent.expectedSize !== '' ? intent.expectedSize : (task.expectedSize ?? ''),
			expectedHash: intent.expectedHash || task.expectedHash || '',
			monitorDownload: intent.monitorDownload === true || details.monitorDownload === true || task.monitorDownload === true,
			metadata: { ...(task.metadata || {}), ...intent.metadata },
			beforeSnapshot: details.beforeSnapshot || details.preSubmitSnapshot || task.beforeSnapshot || null,
			savePathCid: intent.savePathCid,
			processorProfile: intent.processorProfile,
			status: monitor ? 'waiting' : 'recorded',
			message: monitor ? '已登记后台监控' : '已记录任务元数据',
			updatedAt: now,
			lastError: '',
		})
		appendLog(task, task.message)
		await persist(task)
		if (monitor) {
			await global.Push115.Background.TaskMonitor.ensureAlarm()
			void global.Push115.Background.TaskMonitor.processPending()
		}
		return task
	}

	function sameIntent(task, intent) {
		if (!task || !intent) return false
		return global.Push115.DownloadIntent.dedupeKey(task.url || task.magnet) === global.Push115.DownloadIntent.dedupeKey(intent.url)
	}

	async function record(rawIntent) {
		const intent = global.Push115.DownloadIntent.create(rawIntent)
		const records = await read()
		const existing = records.find(task => sameIntent(task, intent))
		if (existing) return { task: existing, duplicate: true }
		const task = await queue({ intent, monitor: false })
		return { task, duplicate: false }
	}

	async function retry(taskId) {
		const records = await read()
		const task = records.find(item => item.taskId === taskId)
		if (!task) throw new Error('找不到任务')
		task.processorProfile = normalizeProcessorProfile(task.processorProfile, task.mediaType === 'anime' ? 'anime' : task.code ? 'jav' : 'generic')
		task.status = 'waiting'
		task.attempts = 0
		task.lastError = ''
		task.updatedAt = Date.now()
		appendLog(task, '用户请求重新处理')
		await persist(task)
		await global.Push115.Background.TaskMonitor.ensureAlarm()
		void global.Push115.Background.TaskMonitor.processPending()
		return task
	}

	global.Push115.Background.TaskStore = {
		read,
		persist,
		clearLogs,
		resetRuntime,
		queue,
		record,
		retry,
		taskIsActive,
		appendLog,
		normalizeLegacyIntent,
	}
})(globalThis)
