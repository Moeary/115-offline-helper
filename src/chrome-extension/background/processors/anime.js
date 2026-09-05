;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const processors = background.Processors
	const api = background.FilesApi
	const folders = background.Folders
	const rules = global.Push115.FileRules
	const fidOf = item => String(item?.fid || item?.file_id || '')
	const isMedia = item => item?.sha && (rules.isVideo(item) || ['.srt', '.ass', '.ssa', '.sup', '.vtt', '.idx', '.sub'].includes(rules.getExtension(folders.nameOf(item))))

	async function collect(sourceCid, destinationCid) {
		const queue = [{ cid: sourceCid, parentCid: destinationCid, depth: 0 }]
		const visited = new Set([destinationCid, '0'])
		const result = { folders: [], files: [] }
		while (queue.length) {
			const folder = queue.shift()
			if (visited.has(folder.cid)) throw new Error('任务目录包含循环或保存目录，暂停整理')
			visited.add(folder.cid)
			const { items, path } = await folders.read(folder.cid)
			if (folders.pathCidOf(path.at(-2)) !== folder.parentCid) throw new Error('任务目录位置发生变化，暂停整理')
			result.folders.push(folder)
			for (const item of items) {
				if (folders.isFolder(item)) queue.push({ cid: folders.cidOf(item), parentCid: folder.cid, depth: folder.depth + 1 })
				else if (isMedia(item) && fidOf(item)) result.files.push({ fid: fidOf(item), name: folders.nameOf(item), parentCid: folder.cid })
			}
		}
		return result
	}

	async function flattenBatchTask(context) {
		const { task, targetCid, folderResolved, config, appendLog } = context
		const checkpoint = context.checkpoint || (() => background.TaskStore.persist(task))
		const destinationCid = String(task.savePathCid || '0')
		let plan = task.animeTransfer
		if (!plan) {
			const sourceCid = String(targetCid || '')
			if (!folderResolved || sourceCid === destinationCid || sourceCid === '0' || !await folders.child(destinationCid, sourceCid)) {
				throw new Error('未定位到本任务的独立目录，等待 115 返回明确位置')
			}
			// Validate the entire tree before applying the existing cleanup algorithm.
			await collect(sourceCid, destinationCid)
			await processors.generic.process({ ...context, config })
			const collected = await collect(sourceCid, destinationCid)
			plan = task.animeTransfer = { version: 1, sourceCid, destinationCid, ...collected, finished: false }
			// Persist IDs before the first move. Restart/retry must never rescan the library.
			await checkpoint()
		}
		if (plan.destinationCid !== destinationCid) throw new Error('任务整理目录已变更，需重新确认')
		if (plan.finished) return ['Anime 归档已完成（沿用上次结果）']

		let destination = (await folders.read(destinationCid)).items
		const movedIds = new Set(destination.filter(item => item.sha).map(fidOf))
		const problems = []
		for (const file of plan.files) {
			if (movedIds.has(file.fid)) continue
			if (destination.some(item => folders.nameOf(item).toLowerCase() === file.name.toLowerCase())) {
				problems.push('同名冲突：' + file.name + '，已保留源文件')
				continue
			}
			try {
				const source = (await folders.read(file.parentCid)).items
				if (!source.some(item => item.sha && fidOf(item) === file.fid)) throw new Error('文件不在原位置')
				if (!api.operationSucceeded(await api.move(file.fid, destinationCid))) throw new Error('115 拒绝移动')
				destination.push({ fid: file.fid, sha: true, n: file.name })
				appendLog(task, '归档：' + file.name)
			} catch (error) { problems.push(file.name + '：' + error.message) }
		}
		// A successful move response alone does not authorize removal of a source folder.
		destination = (await folders.read(destinationCid)).items
		if (plan.files.some(file => !destination.some(item => item.sha && fidOf(item) === file.fid))) {
			for (const problem of problems.slice(0, 10)) appendLog(task, problem)
			throw new Error(problems[0] || '移动结果尚未出现在目标目录，稍后复核')
		}

		let retained = 0
		const parents = new Map(plan.folders.map(folder => [folder.cid, folder.parentCid]))
		async function stillExists(cid) {
			if (cid === destinationCid) return true
			const parentCid = parents.get(cid)
			if (!parentCid || !await stillExists(parentCid)) return false
			return Boolean(await folders.child(parentCid, cid))
		}
		for (const folder of [...plan.folders].sort((a, b) => b.depth - a.depth)) {
			if (!await stillExists(folder.cid)) continue
			const { items } = await folders.read(folder.cid)
			if (items.length) { retained++; continue }
			if (!api.operationSucceeded(await api.remove(folder.cid))) throw new Error('回收空任务目录失败，稍后重试')
			if (await folders.child(folder.parentCid, folder.cid)) throw new Error('空目录回收尚未确认，稍后复核')
			appendLog(task, '已回收空任务目录 ' + folder.cid)
		}
		plan.finished = true
		await checkpoint()
		return [
			'已按原名归档 ' + plan.files.length + ' 个视频/字幕至 ' + (task.metadata?.animeTarget?.name || destinationCid),
			retained ? '保留 ' + retained + ' 个含其他文件的目录' : '空任务目录已清理',
		]
	}

	async function process(context) {
		if (global.Push115.AnimeSeries.needsFlatten(context.task)) return flattenBatchTask(context)
		return processors.generic.process(context)
	}
	processors.anime = { process, flattenBatchTask }
	processors.none = processors.anime
})(globalThis)
