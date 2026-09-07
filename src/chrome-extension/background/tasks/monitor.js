;(function (global) {
	'use strict'
	const store = global.Push115.Background.TaskStore
	const filesApi = global.Push115.Background.FilesApi
	const offlineApi = global.Push115.Background.OfflineApi
	const processors = global.Push115.Background.Processors
	const { normalizeProcessorProfile, STORAGE_KEYS } = global.Push115.Config

	const ALARM_NAME = 'push115-task-monitor'
	const PERIOD_MINUTES = 0.5
	const TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
	// A monitor pass is deliberately bounded.  The cursor is persisted so a
	// large Mikan batch advances fairly across alarm wakeups instead of walking
	// all episodes in one service-worker turn.
	const MAX_TASKS_PER_PASS = 2
	const MONITOR_POLICY = Object.freeze({ concurrency: 1, maxTasksPerPass: MAX_TASKS_PER_PASS, minIntervalMs: 500 })
	let running = false

	function cursorKey() {
		return STORAGE_KEYS?.TASK_MONITOR_CURSOR || 'push115_task_monitor_cursor'
	}

	async function readCursor() {
		try {
			const data = await chrome.storage.local.get(cursorKey())
			return String(data?.[cursorKey()] || '').trim()
		} catch (error) {
			console.warn('[BG] 读取任务轮询游标失败:', error?.message || error)
			return ''
		}
	}

	async function writeCursor(taskId) {
		try {
			await chrome.storage.local.set({ [cursorKey()]: String(taskId || '') })
		} catch (error) {
			console.warn('[BG] 保存任务轮询游标失败:', error?.message || error)
		}
	}

	function selectRoundRobin(active, cursor) {
		if (active.length === 0) return { selected: [], start: 0 }
		const found = active.findIndex(task => String(task.taskId || '') === cursor)
		const start = found >= 0 ? found : 0
		const selected = []
		const count = Math.min(MAX_TASKS_PER_PASS, active.length)
		for (let offset = 0; offset < count; offset += 1) selected.push(active[(start + offset) % active.length])
		return { selected, start }
	}

	function getRemoteTaskId(task) {
		return String(task?.info_hash || task?.infoHash || task?.hash || task?.task_id || task?.taskId || task?.id || '').trim()
	}

	function getRemoteTaskFolderCid(task) {
		// 115's task list normally exposes file_id; older responses use cid or
		// wppath_id. Keep all known aliases so a completed task can still be
		// located after a service-worker restart.
		return String(task?.file_id || task?.fileId || task?.dir_id || task?.dirId || task?.wppath_id || task?.cid || '').trim()
	}

	function remoteTaskMatches(remoteTask, task) {
		const remoteId = getRemoteTaskId(remoteTask)
		if (task.remoteId && remoteId && task.remoteId.toLowerCase() === remoteId.toLowerCase()) return true
		if (task.remoteId && !/^[a-z0-9]{32,40}$/i.test(task.remoteId)) return false
		const remoteName = String(remoteTask?.name || '').trim()
		if (!remoteName || !task.remoteName) return false
		const left = remoteName.toLowerCase()
		const right = task.remoteName.toLowerCase()
		return left === right || left.includes(right) || right.includes(left)
	}

	async function ensureUsableCid(candidateCid) {
		const cid = String(candidateCid || '').trim()
		if (!cid) return ''
		try {
			const list = await filesApi.list(cid)
			if (Array.isArray(list?.data)) return cid
		} catch (error) {
			console.log('[BG] 目录不可用:', cid, error?.message || error)
		}
		return ''
	}

	async function resolveTaskFolder(savePathCid, taskName) {
		if (!taskName) return null
		const list = await filesApi.list(savePathCid)
		if (!Array.isArray(list?.data)) return null
		const folders = list.data.filter(processors.Helpers.isFolder)
		const normalize = value => String(value || '').trim().toLowerCase()
		const wanted = normalize(taskName)
		const exact = folders.find(item => normalize(processors.Helpers.getItemName(item)) === wanted)
		const fuzzy = exact || folders.find(item => normalize(processors.Helpers.getItemName(item)).includes(wanted))
		return fuzzy ? { cid: String(fuzzy.cid || fuzzy.fid || fuzzy.file_id || ''), name: processors.Helpers.getItemName(fuzzy) } : null
	}

	async function getConfigSnapshot() {
		return chrome.storage.local.get([
			'push115_auto_delete_small', 'push115_delete_size_threshold', 'push115_auto_organize',
			'push115_junk_extensions', 'push115_preserve_extensions', 'push115_clean_extensions',
			'push115_clean_images', 'push115_clean_nfo',
		])
	}

	function processorNeedsWork(profile, config, task = null) {
		// 批量 anime 需要在下载完成后把各任务目录扁平化到同一保存目录，
		// 即使用户关闭了常规垃圾清理，也必须保留这项明确的批量整理。
		if (global.Push115.AnimeSeries.needsFlatten(task)) return true
		if (profile === 'jav') return config.push115_auto_delete_small === true || config.push115_auto_organize === true
		return ['generic', 'anime'].includes(profile) && config.push115_auto_delete_small === true
	}

	function notifyTask(task, title, message) {
		if (!chrome.notifications?.create) return
		chrome.notifications.create(`push115-${task.taskId}-${Date.now()}`, {
			type: 'basic', iconUrl: 'icons/icon48.png', title, message,
		})
	}

	async function processTask(task) {
		const config = await getConfigSnapshot()
		const profile = normalizeProcessorProfile(task.processorProfile, task.mediaType === 'anime' ? 'anime' : task.code ? 'jav' : 'generic')
		task.processorProfile = profile
		if (!processorNeedsWork(profile, config, task)) {
			task.status = 'recorded'
			task.message = '已记录任务；对应后处理未开启'
			task.updatedAt = Date.now()
			store.appendLog(task, task.message)
			return
		}
		if (Date.now() - (task.createdAt || Date.now()) > TASK_MAX_AGE_MS) {
			task.status = 'failed'
			task.message = '任务等待超过 7 天，已停止自动监控'
			task.lastError = task.message
			task.updatedAt = Date.now()
			store.appendLog(task, task.message)
			return
		}

		task.attempts = Number(task.attempts || 0) + 1
		// Resume from the persisted file IDs even after the offline record or the
		// now-empty source directory disappears. Never fall back to library-wide cleanup.
		if (profile === 'anime' && task.animeTransfer) {
			await finishProcessing(task, task.animeTransfer.sourceCid, true, config, profile)
			return
		}
		const remoteTasks = await offlineApi.getTasks()
		const flatten = global.Push115.AnimeSeries.needsFlatten(task)
		const remoteTask = remoteTasks.find(item => flatten && task.remoteId
			? getRemoteTaskId(item).toLowerCase() === task.remoteId.toLowerCase()
			: remoteTaskMatches(item, task))
		if (!remoteTask) {
			task.status = 'waiting'
			task.message = `等待 115 任务出现（第 ${task.attempts} 次检查）`
			task.updatedAt = Date.now()
			if (task.attempts === 1 || task.attempts % 10 === 0) store.appendLog(task, task.message)
			return
		}

		task.remoteName = String(remoteTask.name || task.remoteName || '').trim()
		task.remoteId = getRemoteTaskId(remoteTask) || task.remoteId
		const percent = Number(remoteTask.percentDone)
		const remoteStatus = Number(remoteTask.status)
		const remoteState = Number(remoteTask.state)
		const completed = remoteStatus === 2 || percent === 100 || remoteState === 1
		if (remoteStatus === -1 || remoteState === 2) {
			task.status = 'failed'
			task.message = `115 离线任务失败：${remoteTask.error_msg || '未知错误'}`
			task.lastError = task.message
			task.updatedAt = Date.now()
			store.appendLog(task, task.message)
			return
		}
		if (!completed) {
			task.status = 'processing'
			task.percent = Number.isFinite(percent) ? percent : null
			task.message = Number.isFinite(percent) ? `115 离线下载中（${percent}%）` : '115 离线下载处理中'
			task.updatedAt = Date.now()
			if (task.attempts === 1 || task.attempts % 5 === 0) store.appendLog(task, task.message)
			return
		}

		if (flatten) {
			const folders = global.Push115.Background.Folders
			const items = (await folders.read(task.savePathCid)).items
			const remoteCid = getRemoteTaskFolderCid(remoteTask)
			let source = items.find(item => folders.isFolder(item) && folders.cidOf(item) === remoteCid)
			if (!source) {
				const exact = items.filter(item => folders.isFolder(item) && folders.nameOf(item) === task.remoteName)
				if (exact.length === 1) source = exact[0]
			}
			if (!source) {
				// Some single-file torrents already arrive directly in the chosen folder.
				const direct = items.find(item => item.sha && String(item.fid || item.file_id || '') === remoteCid)
				if (direct) {
					task.status = 'completed'
					task.completedAt = task.updatedAt = Date.now()
					task.message = '视频已直接保存在目标目录，无需移动'
					store.appendLog(task, task.message)
					return
				}
				throw new Error('未明确定位到本任务目录，保留文件等待重试')
			}
			await finishProcessing(task, folders.cidOf(source), true, config, profile)
			return
		}

		let folderCid = String(task.remoteFolderCid || '').trim() || getRemoteTaskFolderCid(remoteTask)
		let folderResolved = false
		if (folderCid) {
			const usable = await ensureUsableCid(folderCid)
			if (usable) {
				folderCid = usable
				folderResolved = true
			}
		}
		if (!folderResolved) {
			const found = await resolveTaskFolder(task.savePathCid, task.remoteName)
			if (found?.cid) {
				folderCid = found.cid
				task.folderName = found.name
				folderResolved = Boolean(await ensureUsableCid(folderCid))
			}
		}
		const targetCid = folderCid || await ensureUsableCid(task.savePathCid)
		if (!targetCid) throw new Error('未找到下载完成后的 115 目录')
		await finishProcessing(task, targetCid, folderResolved, config, profile)
	}

	async function finishProcessing(task, targetCid, folderResolved, config, profile) {
		task.status = 'processing'
		task.remoteFolderCid = folderResolved ? targetCid : ''
		task.updatedAt = Date.now()
		store.appendLog(task, `离线下载完成，开始执行 ${profile} 后处理`)
		const processor = processors[profile] || processors.generic
		const messages = await processor.process({ task, targetCid, folderResolved, config, appendLog: store.appendLog, checkpoint: () => store.persist(task) })
		task.status = 'completed'
		task.completedAt = Date.now()
		task.message = messages.length > 0 ? messages.join('，') : '处理完成，未发现需要修改的文件'
		task.updatedAt = Date.now()
		store.appendLog(task, task.message)
		notifyTask(task, '115 离线助手处理完成', task.message)
	}

	async function processPending() {
		if (running) return
		running = true
		try {
			const tasks = await store.read()
			const active = tasks.filter(store.taskIsActive)
			if (active.length === 0) {
				await writeCursor('')
				return
			}
			const { selected, start } = selectRoundRobin(active, await readCursor())
			for (let offset = 0; offset < selected.length; offset += 1) {
				const task = selected[offset]
				try {
					await processTask(task)
				} catch (error) {
					task.status = 'waiting'
					task.lastError = error?.message || String(error)
					task.message = `后台处理遇到波动，将稍后重试：${task.lastError}`
					task.updatedAt = Date.now()
					if (task.attempts === 0 || task.attempts % 5 === 0) store.appendLog(task, task.message)
				}
				await store.persist(task)
				const nextIndex = (start + offset + 1) % active.length
				await writeCursor(active[nextIndex]?.taskId || '')
			}
		} finally {
			running = false
		}
	}

	async function ensureAlarm() {
		if (!await chrome.alarms.get(ALARM_NAME)) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES })
	}

	global.Push115.Background.TaskMonitor = {
		ALARM_NAME,
		MONITOR_POLICY,
		ensureAlarm,
		processPending,
		processTask,
		selectRoundRobin,
	}
})(globalThis)
