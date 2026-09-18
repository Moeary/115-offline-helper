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

	function getRemoteTaskIds(task) {
		const values = [task?.info_hash, task?.infoHash, task?.hash, task?.task_id, task?.taskId, task?.id]
		const seen = new Set()
		return values.map(value => String(value || '').trim()).filter(value => {
			const key = value.toLowerCase()
			if (!key || seen.has(key)) return false
			seen.add(key)
			return true
		})
	}

	function getRemoteTaskId(task) {
		return getRemoteTaskIds(task)[0] || ''
	}

	function getRemoteTaskFileId(task) {
		return String(task?.fid || task?.file_id || task?.fileId || '').trim()
	}

	function getRemoteTaskFolderCid(task) {
		// 115's task list normally exposes file_id; older responses use cid or
		// dir_id. `wppath_id` is the configured save path, not an output folder;
		// treating it as a task directory can make cleanup scan the whole root.
		return String(task?.file_id || task?.fileId || task?.dir_id || task?.dirId || task?.cid || '').trim()
	}

	function remoteTaskSize(task) {
		const value = task?.size ?? task?.file_size ?? task?.fileSize ?? task?.total_size ?? task?.totalSize ?? task?.length
		const parsed = Number(String(value ?? '').replace(/\s+/g, '').trim())
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
	}

	function remoteTaskHash(task) {
		return String(task?.ed2k_hash || task?.ed2kHash || task?.file_hash || task?.fileHash || task?.content_hash || task?.contentHash || '').trim().toLowerCase()
	}

	function remoteTaskMetadataMatches(remoteTask, task) {
		const expected = expectedValues(task)
		const actualSize = remoteTaskSize(remoteTask)
		if (expected.size > 0 && actualSize > 0 && actualSize !== expected.size) return false
		const actualHash = remoteTaskHash(remoteTask)
		if (expected.hash && actualHash && actualHash !== expected.hash) return false
		return true
	}

	function remoteTaskMatches(remoteTask, task) {
		const remoteIds = getRemoteTaskIds(remoteTask).map(value => value.toLowerCase())
		const identifiers = [task?.remoteId, task?.jobId, task?.metadata?.bridgeJobId]
			.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
		if (remoteIds.length > 0 && identifiers.length > 0) return remoteIds.some(value => identifiers.includes(value))
		const remoteName = String(remoteTask?.name || '').trim()
		const expectedName = String(task?.expectedName || task?.remoteName || '').trim()
		if (!remoteName || !expectedName) return false
		// A name can be used only as an exact legacy fallback.  Substring
		// matching can attach a completed task to another same-prefix download.
		return remoteName.toLowerCase() === expectedName.toLowerCase() && remoteTaskMetadataMatches(remoteTask, task)
	}

	async function ensureUsableCid(candidateCid) {
		const cid = String(candidateCid || '').trim()
		if (!cid) return ''
		try {
			if (global.Push115.Background.Folders?.read) {
				await global.Push115.Background.Folders.read(cid)
				return cid
			}
			const list = await filesApi.list(cid)
			if (Array.isArray(list?.data)) return cid
		} catch (error) {
			console.log('[BG] 目录不可用:', cid, error?.message || error)
		}
		return ''
	}

	async function resolveTaskFolder(savePathCid, taskName) {
		if (!taskName) return null
		const list = global.Push115.Background.Folders?.read
			? await global.Push115.Background.Folders.read(savePathCid)
			: await filesApi.list(savePathCid)
		const items = Array.isArray(list?.items) ? list.items : list?.data
		if (!Array.isArray(items)) return null
		const folders = items.filter(processors.Helpers.isFolder)
		const normalize = value => String(value || '').trim().toLowerCase()
		const wanted = normalize(taskName)
		const exact = folders.filter(item => normalize(processors.Helpers.getItemName(item)) === wanted)
		if (exact.length !== 1) return null
		const folder = exact[0]
		return { cid: String(folder.cid || folder.fid || folder.file_id || ''), name: processors.Helpers.getItemName(folder) }
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

	async function completeDirectFile(task, direct, config, profile) {
		task.directFileId = direct.fid
		task.directFileCid = direct.cid
		// JAV has an explicit single-file processor. Other profiles are marked
		// complete after identity verification; generic cleanup must not scan the
		// entire save root merely because a torrent produced one file there.
		if (profile === 'jav' && config.push115_auto_organize === true) {
			const processor = processors.jav
			if (typeof processor?.processDirect !== 'function') throw new Error('JAV 单文件处理器不可用')
			const messages = await processor.processDirect({
				task,
				targetCid: String(task.savePathCid || direct.cid),
				targetFile: direct.item,
				config,
				appendLog: store.appendLog,
				checkpoint: () => store.persist(task),
			})
			task.message = messages.length > 0 ? messages.join('，') : '已确认单文件下载结果'
		} else {
			task.message = '已确认单文件下载结果，保留其他目录内容'
		}
		task.status = 'completed'
		task.completedAt = task.updatedAt = Date.now()
		store.appendLog(task, task.message)
		if (profile === 'jav' && config.push115_auto_organize === true) notifyTask(task, '115 离线助手处理完成', task.message)
	}

	async function processTask(task) {
		const config = await getConfigSnapshot()
		const profile = normalizeProcessorProfile(task.processorProfile, task.mediaType === 'anime' ? 'anime' : task.code ? 'jav' : 'generic')
		task.processorProfile = profile
		const forcedMonitoring = task.monitorDownload === true || task.metadata?.monitorDownload === true
		if (!processorNeedsWork(profile, config, task) && !forcedMonitoring) {
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
		if (profile === 'jav' && task.directPlan) {
			const direct = await resolveDirectFile(task, null)
			if (direct) {
				await completeDirectFile(task, direct, config, profile)
				return
			}
		}
		const remoteTasks = await offlineApi.getTasks()
		const flatten = global.Push115.AnimeSeries.needsFlatten(task)
		const stableJobId = String(task.remoteId || task.jobId || task.metadata?.bridgeJobId || '').trim().toLowerCase()
		const matchingRemoteTasks = remoteTasks.filter(item => flatten && stableJobId
			? getRemoteTaskIds(item).some(value => value.toLowerCase() === stableJobId)
			: remoteTaskMatches(item, task))
		if (matchingRemoteTasks.length > 1) {
			throw new Error('无法唯一确认对应的 115 任务，保留任务等待重试')
		}
		const remoteTask = matchingRemoteTasks[0]
		if (!remoteTask) {
			task.status = 'waiting'
			task.message = `等待 115 任务出现（第 ${task.attempts} 次检查）`
			task.updatedAt = Date.now()
			if (task.attempts === 1 || task.attempts % 10 === 0) store.appendLog(task, task.message)
			return
		}

		task.remoteName = String(remoteTask.name || task.remoteName || '').trim()
		task.remoteId = getRemoteTaskId(remoteTask) || task.remoteId
		task.jobId = task.jobId || task.remoteId || getRemoteTaskId(remoteTask)
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
			const direct = await resolveDirectFile(task, remoteTask)
			if (direct) {
				await completeDirectFile(task, direct, config, profile)
				return
			}
			const items = (await folders.read(task.savePathCid)).items
			const remoteCid = getRemoteTaskFolderCid(remoteTask)
			let source = items.find(item => folders.isFolder(item) && folders.cidOf(item) === remoteCid)
			if (!source) {
				const exact = items.filter(item => folders.isFolder(item) && folders.nameOf(item) === task.remoteName)
				if (exact.length === 1) source = exact[0]
			}
			if (!source) {
				throw new Error('未明确定位到本任务目录，保留文件等待重试')
			}
			await finishProcessing(task, folders.cidOf(source), true, config, profile)
			return
		}
		const direct = await resolveDirectFile(task, remoteTask)
		if (direct) {
			await completeDirectFile(task, direct, config, profile)
			return
		}

		if (forcedMonitoring && !processorNeedsWork(profile, config, task)) {
			task.status = 'completed'
			task.completedAt = task.updatedAt = Date.now()
			task.message = '115 离线下载完成'
			store.appendLog(task, task.message)
			return
		}

		let folderCid = String(task.remoteFolderCid || '').trim() || getRemoteTaskFolderCid(remoteTask)
		if (folderCid === String(task.savePathCid || '').trim()) folderCid = ''
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
		const targetCid = folderResolved ? folderCid : ''
		if (!targetCid) throw new Error('未找到下载完成后的 115 目录')
		await finishProcessing(task, targetCid, folderResolved, config, profile)
	}

	function itemId(item) {
		return String(item?.fid ?? item?.file_id ?? item?.fileId ?? '').trim()
	}

	function itemName(item) {
		return String(item?.n || item?.name || '').trim()
	}

	function itemSize(item) {
		const value = Number(item?.size ?? item?.s ?? item?.file_size ?? item?.fileSize ?? 0)
		return Number.isFinite(value) && value >= 0 ? value : 0
	}

	function itemHash(item) {
		return String(item?.hash || item?.ed2kHash || item?.file_hash || item?.content_hash || '').trim().toLowerCase()
	}

	function expectedValues(task) {
		const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}
		const sizeValue = task?.expectedSize ?? metadata.expectedSize ?? metadata.ed2kSize ?? ''
		const parsedSize = String(sizeValue ?? '').replace(/\s+/g, '').trim()
		return {
			name: String(task?.expectedName || metadata.expectedName || metadata.ed2kFileName || '').trim(),
			size: /^\d+$/.test(parsedSize) ? Number(parsedSize) : 0,
			hash: String(task?.expectedHash || metadata.expectedHash || metadata.ed2kHash || '').trim().toLowerCase(),
		}
	}

	function snapshotIds(task) {
		const snapshot = task?.beforeSnapshot || task?.preSubmitSnapshot || task?.metadata?.beforeSnapshot
		const items = Array.isArray(snapshot?.items) ? snapshot.items : Array.isArray(snapshot?.files) ? snapshot.files : []
		return new Set(items.map(item => String(item?.fid ?? item?.file_id ?? item?.fileId ?? '').trim()).filter(Boolean))
	}

	function directReference(task) {
		return String(task?.directFileId || task?.directFid || task?.directPlan?.fid || '').trim()
	}

	function directExpectationKey(task) {
		const expected = expectedValues(task)
		const profile = normalizeProcessorProfile(task?.processorProfile, task?.mediaType === 'anime' ? 'anime' : task?.code ? 'jav' : 'generic')
		if (profile !== 'jav' || !expected.name || expected.size <= 0) return ''
		return [
			String(task?.savePathCid || '').trim(),
			expected.name.toLowerCase(),
			String(expected.size),
			expected.hash,
		].join('|')
	}

	function metadataMatches(item, task, { requireExpected = false } = {}) {
		if (!item?.sha) return false
		const expected = expectedValues(task)
		const plannedName = String(task?.directPlan?.targetName || '').trim()
		if (expected.name && itemName(item) !== expected.name && itemName(item) !== plannedName) return false
		if (expected.size > 0 && itemSize(item) !== expected.size) return false
		if (expected.hash) {
			const actual = itemHash(item)
			// `sha` is the file-presence marker in 115 listings, so only compare
			// it when it itself looks like the expected ED2K hash.  Other hash
			// aliases are authoritative when supplied by the API.
			if (actual && actual !== expected.hash) return false
			if (!actual && String(item?.sha || '').trim().toLowerCase() === expected.hash) return true
			// Most 115 listings expose `sha` as an opaque presence marker rather
			// than the ED2K hash.  A missing ED2K-specific field is inconclusive;
			// filename and size remain the exact identity checks in that case.
		}
		return !requireExpected || Boolean(expected.name || expected.size > 0 || expected.hash)
	}

	async function readFolder(cid) {
		const value = String(cid || '').trim()
		if (!value) throw new Error('缺少整理目录 CID')
		const folders = global.Push115.Background.Folders
		if (folders?.read) return folders.read(value)
		const result = await filesApi.list(value)
		if (!Array.isArray(result?.data)) throw new Error(`无法读取目录 ${value}`)
		return { items: result.data, path: result.path }
	}

	async function resolveDirectFile(task, remoteTask) {
		const targetCid = String(task?.savePathCid || '').trim()
		if (!targetCid) return null
		const snapshot = task?.beforeSnapshot || task?.preSubmitSnapshot || task?.metadata?.beforeSnapshot
		if (snapshot && String(snapshot.cid || '').trim() && String(snapshot.cid).trim() !== targetCid) {
			throw new Error('提交前目录快照与任务保存目录不一致，保留文件等待复核')
		}
		const remoteFid = getRemoteTaskFileId(remoteTask)
		const persistedFid = String(task?.directFileId || task?.directFid || task?.directPlan?.fid || '').trim()
		const fid = persistedFid || remoteFid
		const knownCids = [...new Set([
			String(task?.directPlan?.currentCid || '').trim(),
			String(task?.directPlan?.destinationCid || '').trim(),
			String(task?.directPlan?.sourceCid || '').trim(),
			String(task?.directFileCid || '').trim(),
			targetCid,
		].filter(Boolean))]
		let files = []
		let lastReadError = null
		if (fid) {
			for (const cid of knownCids) {
				let listing
				try {
					listing = await readFolder(cid)
				} catch (error) {
					// A move can remove the source directory before the checkpoint is
					// persisted. Continue only through the other explicitly recorded
					// CIDs; never substitute an inferred root or library-wide scan.
					lastReadError = error
					continue
				}
				files = (Array.isArray(listing?.items) ? listing.items : []).filter(item => item?.sha)
				const found = files.find(item => itemId(item) === fid)
				if (found && metadataMatches(found, task, { requireExpected: false })) {
					return { cid, fid, item: found, direct: true }
				}
				if (found) throw new Error('下载产物与预期文件不符，保留文件等待复核')
			}
		}
		let listing
		try {
			listing = await readFolder(targetCid)
		} catch (error) {
			throw lastReadError || error
		}
		const items = Array.isArray(listing?.items) ? listing.items : []
		files = items.filter(item => item?.sha)
		const expected = expectedValues(task)
		if (!expected.name && expected.size <= 0 && !expected.hash) return null
		if (!snapshot || (!Array.isArray(snapshot.items) && !Array.isArray(snapshot.files))) return null
		const before = snapshotIds(task)
		const occupied = new Set()
		for (const other of await store.read()) {
			if (!other || other.taskId === task.taskId) continue
			const otherFid = String(other.directFileId || other.directFid || other.directPlan?.fid || '').trim()
			if (otherFid) occupied.add(otherFid)
		}
		files = files.filter(item => !before.has(itemId(item)) && !occupied.has(itemId(item))
			&& metadataMatches(item, task, { requireExpected: true }))
		if (files.length === 1) {
			const found = files[0]
			const expectationKey = directExpectationKey(task)
			if (expectationKey) {
				const ambiguous = (await store.read()).some(other => other && other.taskId !== task.taskId
					&& store.taskIsActive(other) && !directReference(other) && directExpectationKey(other) === expectationKey)
				if (ambiguous) throw new Error('存在相同预期任务，无法唯一确认下载完成的文件，保留文件等待重试')
			}
			return { cid: targetCid, fid: itemId(found), item: found, direct: true }
		}
		if (files.length > 1) throw new Error('无法唯一确认下载完成的文件，保留文件等待重试')
		return null
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
