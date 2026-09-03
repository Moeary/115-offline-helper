;(function (global) {
	'use strict'
	const processors = global.Push115.Background.Processors
	const filesApi = global.Push115.Background.FilesApi
	const rulesApi = global.Push115.FileRules
	const { getItemName, getItemId, isFolder } = processors.Helpers

	const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.sup', '.vtt'])

	function isSubtitle(item) {
		return SUBTITLE_EXTENSIONS.has(rulesApi.getExtension(getItemName(item)))
	}

	function isTransferable(item) {
		return Boolean(item?.sha && (rulesApi.isVideo(item) || isSubtitle(item)))
	}

	async function listFolder(cid) {
		const result = await filesApi.list(cid)
		return Array.isArray(result?.data) ? result.data : null
	}

	async function collectFiles(rootCid, appendLog, task) {
		const queue = [{ cid: String(rootCid), depth: 0 }]
		const visited = new Set()
		const folders = []
		const files = []
		while (queue.length > 0) {
			const current = queue.shift()
			if (!current.cid || visited.has(current.cid)) continue
			visited.add(current.cid)
			const data = await listFolder(current.cid)
			if (!data) {
				appendLog(task, `无法读取任务目录 ${current.cid}，为安全起见保留原目录`)
				continue
			}
			folders.push({ cid: current.cid, depth: current.depth })
			for (const item of data) {
				if (isFolder(item)) {
					const childCid = String(item.cid || item.fid || item.file_id || '').trim()
					if (childCid && !visited.has(childCid)) queue.push({ cid: childCid, depth: current.depth + 1 })
				} else if (isTransferable(item)) {
					const fid = getItemId(item)
					if (fid) files.push({ fid, name: getItemName(item), parentCid: current.cid })
				}
			}
		}
		return { folders, files }
	}

	async function removeEmptyFolders(folders, rootCid, appendLog, task) {
		let removed = 0
		const ordered = [...folders].sort((left, right) => right.depth - left.depth)
		for (const folder of ordered) {
			if (folder.cid === String(rootCid)) continue
			const data = await listFolder(folder.cid)
			if (!data || data.length !== 0) continue
			if (filesApi.operationSucceeded(await filesApi.remove(folder.cid))) removed += 1
		}
		const rootData = await listFolder(rootCid)
		if (Array.isArray(rootData) && rootData.length === 0 && String(rootCid) !== '0') {
			if (filesApi.operationSucceeded(await filesApi.remove(rootCid))) {
				removed += 1
				appendLog(task, '已确认任务目录为空并删除')
			}
		}
		return removed
	}

	async function flattenBatchTask(context) {
		const { task, targetCid, folderResolved, appendLog } = context
		const log = typeof appendLog === 'function' ? appendLog : () => {}
		const sourceCid = String(targetCid || '').trim()
		const destinationCid = String(task.savePathCid || '0').trim() || '0'
		if (!folderResolved || !sourceCid || sourceCid === '0' || sourceCid === destinationCid) {
			log(task, '批量 Anime 未定位到独立任务目录，保留原目录结构')
			return []
		}

		const collected = await collectFiles(sourceCid, log, task)
		let moved = 0
		let failed = 0
		for (const file of collected.files) {
			try {
				const result = await filesApi.move(file.fid, destinationCid)
				if (filesApi.operationSucceeded(result)) moved += 1
				else {
					failed += 1
					log(task, `移动失败：${file.name}`)
				}
			} catch (error) {
				failed += 1
				log(task, `移动失败：${file.name}（${error?.message || error}）`)
			}
		}

		const removed = await removeEmptyFolders(collected.folders, sourceCid, log, task)
		const messages = []
		if (moved > 0) messages.push(`批量 Anime 移动 ${moved} 个视频/字幕到保存目录`)
		if (removed > 0) messages.push(`删除 ${removed} 个空任务文件夹`)
		if (failed > 0) messages.push(`${failed} 个文件移动失败，已保留原位置`)
		if (moved === 0 && removed === 0 && failed === 0) messages.push('批量 Anime 未发现可扁平化的视频或字幕')
		return messages
	}

	async function process(context) {
		const messages = await processors.generic.process(context)
		// 普通 anime 仍保留 torrent 原始名称和目录结构。只有同一个确认窗口
		// 提交的批量任务才会被扁平化，避免改变单条下载的既有语义。
		if (context.task?.metadata?.batchId) {
			messages.push(...await flattenBatchTask(context))
		}
		return messages
	}

	processors.anime = { process, flattenBatchTask }
	processors.none = processors.anime
})(globalThis)
