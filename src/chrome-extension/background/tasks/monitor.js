;(function (global) {
	'use strict'
	const store = global.Push115.Background.TaskStore
	const filesApi = global.Push115.Background.FilesApi
	const offlineApi = global.Push115.Background.OfflineApi
	const processors = global.Push115.Background.Processors
	const { normalizeProcessorProfile } = global.Push115.Config

	const ALARM_NAME = 'push115-task-monitor'
	const PERIOD_MINUTES = 0.5
	const TASK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
	let running = false

	function getRemoteTaskId(task) {
		return String(task?.info_hash || task?.infoHash || task?.hash || task?.task_id || task?.taskId || task?.id || '').trim()
	}

	function getRemoteTaskFolderCid(task) {
		return String(task?.file_id || task?.fileId || task?.dir_id || task?.dirId || task?.wppath_id || '').trim()
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

	function processorNeedsWork(profile, config) {
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
		if (!processorNeedsWork(profile, config)) {
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
		const remoteTasks = await offlineApi.getTasks()
		const remoteTask = remoteTasks.find(item => remoteTaskMatches(item, task))
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

		task.status = 'processing'
		task.remoteFolderCid = folderResolved ? targetCid : ''
		task.updatedAt = Date.now()
		store.appendLog(task, `离线下载完成，开始执行 ${profile} 后处理`)
		const processor = processors[profile] || processors.generic
		const messages = await processor.process({ task, targetCid, folderResolved, config, appendLog: store.appendLog })
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
			for (const task of tasks.filter(store.taskIsActive)) {
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
		ensureAlarm,
		processPending,
		processTask,
	}
})(globalThis)
