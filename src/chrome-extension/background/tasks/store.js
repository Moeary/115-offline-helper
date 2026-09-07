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
		return rememberTasks(Array.isArray(data[STORAGE_KEYS.TASKS]) ? data[STORAGE_KEYS.TASKS] : [])
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
		const pageCode = intentApi.normalizeCode(metadata.pageCode)
		const code = pageCode || intentApi.normalizeCode(input.code) || intentApi.normalizeCode(input.name) || intentApi.normalizeCode(input.title)
		const explicitProcessor = input.processorProfile
		const processorProfile = explicitProcessor
			? normalizeProcessorProfile(explicitProcessor, input.mediaType === 'anime' ? 'anime' : 'generic')
			: (code ? 'jav' : input.mediaType === 'anime' ? 'anime' : 'generic')
		return {
			sourceSite: String(input.sourceSite || input.source || 'generic').trim().toLowerCase() || 'generic',
			mediaType: ['generic', 'jav', 'anime'].includes(input.mediaType) ? input.mediaType : 'generic',
			url,
			title: String(input.title || '').trim(),
			code,
			metadata: { ...metadata, btih: metadata.btih || intentApi.extractBtih(url) },
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
		const remoteName = String(details.name || intentApi.extractDisplayName(intent.url) || '').trim()
		// Keep the legacy QUEUE_TASK contract: callers that omit monitor asked for
		// persistent monitoring. New SUBMIT_INTENT callers pass an explicit bool.
		const monitor = details.monitor === undefined ? true : details.monitor === true
		const records = await read()
		const existing = records.find(task => taskIsActive(task) && (
			(remoteId && String(task.remoteId || '').toLowerCase() === remoteId) ||
			(intent.url && (task.url === intent.url || task.magnet === intent.url))
		))
		const task = existing || { taskId: makeTaskId(), createdAt: now, attempts: 0, logs: [] }
		rememberTask(task)

		Object.assign(task, {
			remoteId: remoteId || task.remoteId || '',
			remoteName: remoteName || task.remoteName || '',
			url: intent.url || task.url || task.magnet || '',
			magnet: intent.url || task.magnet || '',
			sourceSite: intent.sourceSite,
			source: intent.sourceSite,
			mediaType: intent.mediaType,
			title: intent.title || task.title || '',
			code: intent.code || task.code || '',
			metadata: { ...(task.metadata || {}), ...intent.metadata },
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
		retry,
		taskIsActive,
		appendLog,
		normalizeLegacyIntent,
	}
})(globalThis)
