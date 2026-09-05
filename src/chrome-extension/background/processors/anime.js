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
			const folderName = folders.nameOf(path.at(-1))
			result.folders.push({ ...folder, name: folderName })
			const wrapperVideoName = inferWrapperVideoName(folderName, items)
			for (const item of items) {
				if (folders.isFolder(item)) queue.push({ cid: folders.cidOf(item), parentCid: folder.cid, depth: folder.depth + 1 })
				else if ((isMedia(item) || (wrapperVideoName && !rules.getExtension(folders.nameOf(item)))) && fidOf(item)) {
					const name = wrapperVideoName ? wrapperVideoName : folders.nameOf(item)
					result.files.push({ fid: fidOf(item), name, parentCid: folder.cid })
				}
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
		const pendingFiles = plan.files.filter(file => !movedIds.has(file.fid))
		let stagedFileIds = new Set()
		if (pendingFiles.length > 0) {
			await rejectDestinationConflicts(plan, destinationCid, destination, pendingFiles)
			const staged = await stageSameNameFiles(task, plan, destinationCid, destination, pendingFiles, checkpoint, appendLog)
			stagedFileIds = new Set(staged?.fileIds || [])
			destination = (await folders.read(destinationCid)).items
		}
		const problems = []
		for (const file of plan.files) {
			if (movedIds.has(file.fid)) continue
			if (destination.some(item => sameName(folders.nameOf(item), file.name))) {
				problems.push('同名冲突：' + file.name + '，已保留源文件')
				continue
			}
			try {
				const sourceCid = stagedFileIds.has(file.fid) ? String(plan.staging?.cid || '') : file.parentCid
				if (!sourceCid) throw new Error('临时任务目录状态缺失')
				const source = (await folders.read(sourceCid)).items
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

		const retained = await removeEmptyPlannedFolders(task, plan, destinationCid, appendLog)
		await restoreDestinationFileNames(task, plan, destinationCid, checkpoint, appendLog)
		await cleanupStagingFolder(task, plan, destinationCid, appendLog)
		plan.finished = true
		await checkpoint()
		return [
			'已按原名归档 ' + plan.files.length + ' 个视频/字幕至 ' + (task.metadata?.animeTarget?.name || destinationCid),
			retained ? '保留 ' + retained + ' 个含其他文件的目录' : '空任务目录已清理',
		]
	}

	function stagingName(task) {
		const taskPart = String(task?.taskId || '').replace(/[^a-z0-9]/gi, '').slice(-18) || 'task'
		return `__push115_stage_${taskPart}`
	}

	function sameName(left, right) {
		return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
	}

	function isVideoName(name) {
		return rules.isVideo({ n: String(name || '') })
	}

	function inferWrapperVideoName(folderName, items, sourceItem = null) {
		if (!isVideoName(folderName)) return ''
		const files = (Array.isArray(items) ? items : []).filter(item => item?.sha && fidOf(item))
		if (files.length !== 1) return ''
		if (sourceItem && fidOf(files[0]) !== fidOf(sourceItem)) return ''
		// A previous build could rename the only video to a release-group prefix
		// such as `[NEST]`, losing its extension. Treat a single extensionless
		// file as the video represented by a `.mkv`/`.mp4` wrapper, but never
		// infer a video name for a known subtitle or other file type.
		const only = files[0]
		return rules.isVideo(only) || !rules.getExtension(folders.nameOf(only)) ? String(folderName) : ''
	}

	function plannedWrapperVideoName(listing, sourceItem) {
		const folderName = folders.nameOf(listing.path.at(-1))
		return inferWrapperVideoName(folderName, listing.items, sourceItem)
	}

	function planFolderParents(plan) {
		return new Map((plan.folders || []).map(folder => [String(folder.cid), String(folder.parentCid || '')]))
	}

	function ancestorFolderIds(plan, destinationCid, parentCid) {
		const parents = planFolderParents(plan)
		const result = new Set()
		let current = String(parentCid || '')
		const destination = String(destinationCid || '')
		while (current && current !== destination && !result.has(current)) {
			result.add(current)
			current = parents.get(current) || ''
		}
		return result
	}

	async function rejectDestinationConflicts(plan, destinationCid, destination, pendingFiles) {
		const problems = []
		for (const file of pendingFiles) {
			const allowedSourceFolders = ancestorFolderIds(plan, destinationCid, file.parentCid)
			const conflict = destination.find(item => sameName(folders.nameOf(item), file.name) && (
				item.sha || !allowedSourceFolders.has(folders.cidOf(item))
			))
			if (conflict) problems.push('同名冲突：' + file.name + '，已保留源文件')
		}
		if (problems.length) throw new Error(problems[0])
	}

	async function resolveStagingFolder(plan, destinationCid, destination, fileIds) {
		const remembered = plan.staging && typeof plan.staging === 'object' ? plan.staging : null
		if (!remembered?.cid) return null
		const cid = String(remembered.cid)
		try {
			const listing = await folders.read(cid)
			if (folders.pathCidOf(listing.path.at(-2)) === destinationCid) return { ...remembered, cid }
		} catch (error) {
			// A worker can stop after the temporary folder is removed. The caller
			// decides whether every staged file is already present in the target.
		}
		const child = destination.find(item => folders.isFolder(item) && (
			folders.cidOf(item) === cid || sameName(folders.nameOf(item), remembered.name)
		))
		if (child) return { ...remembered, cid: folders.cidOf(child) }
		const wanted = new Set(fileIds)
		const destinationIds = new Set(destination.filter(item => item.sha).map(fidOf))
		const allInDestination = wanted.size > 0 && [...wanted].every(fid => destinationIds.has(fid))
		if (allInDestination) return null
		throw new Error('临时任务目录不存在，无法恢复暂存文件')
	}

	async function findSameNameStageFiles(plan, destinationCid, pendingFiles) {
		const remembered = plan.staging && typeof plan.staging === 'object' ? plan.staging : null
		if (remembered?.cid && Array.isArray(remembered.fileIds)) return [...new Set(remembered.fileIds.map(String))]
		const parents = planFolderParents(plan)
		const parentNames = new Map()
		const sameNameParents = new Set()
		const sourceListings = new Map()
		const restoreNames = new Set()
		async function sourceListing(parentCid) {
			const cid = String(parentCid || '')
			if (!sourceListings.has(cid)) sourceListings.set(cid, await folders.read(cid))
			return sourceListings.get(cid)
		}
		for (const file of pendingFiles) {
			const listing = await sourceListing(file.parentCid)
			const sourceItem = listing.items.find(item => item.sha && fidOf(item) === String(file.fid))
			if (!sourceItem) throw new Error('暂存文件不在原位置，稍后重试')
			const wrapperVideoName = plannedWrapperVideoName(listing, sourceItem)
			if (wrapperVideoName && !sameName(file.name, wrapperVideoName)) file.name = wrapperVideoName
			// Older Anime/Mikan builds could leave a shortened or otherwise
			// temporary file name behind.  Keep the name captured in the plan and
			// restore it while the file is safely inside the staging directory.
			if (folders.nameOf(sourceItem) !== String(file.name || '')) restoreNames.add(String(file.fid))
			let parentCid = String(file.parentCid || '')
			const visited = new Set()
			while (parentCid && parentCid !== String(destinationCid) && !visited.has(parentCid)) {
				visited.add(parentCid)
				if (!parentNames.has(parentCid)) {
					const parentListing = await sourceListing(parentCid)
					if (folders.pathCidOf(parentListing.path.at(-2)) !== String(parents.get(parentCid) || destinationCid)) {
						throw new Error('任务目录位置发生变化，暂停整理')
					}
					parentNames.set(parentCid, folders.nameOf(parentListing.path.at(-1)))
				}
				if (sameName(file.name, parentNames.get(parentCid))) sameNameParents.add(parentCid)
				parentCid = parents.get(parentCid) || ''
			}
		}
		return plan.files.filter(file => {
			if (restoreNames.has(String(file.fid))) return true
			let parentCid = String(file.parentCid || '')
			const visited = new Set()
			while (parentCid && parentCid !== String(destinationCid) && !visited.has(parentCid)) {
				if (sameNameParents.has(parentCid)) return true
				visited.add(parentCid)
				parentCid = parents.get(parentCid) || ''
			}
			return false
		}).map(file => String(file.fid))
	}

	async function stageSameNameFiles(task, plan, destinationCid, destination, pendingFiles, checkpoint, appendLog) {
		let remembered = plan.staging && typeof plan.staging === 'object' ? plan.staging : null
		// 1.3.x stored a rename attempt as { originalName, name }. If that
		// attempt never changed the source, discard the marker and use the safer
		// file-inventory staging flow below. A successful legacy rename remains
		// usable and needs no temporary directory.
		if (remembered && !remembered.cid) {
			const sourceCid = String(plan.sourceCid || '')
			try {
				const sourceListing = await folders.read(sourceCid)
				const sourceName = folders.nameOf(sourceListing.path.at(-1))
				if (remembered.name && !sameName(sourceName, remembered.name)) {
					delete plan.staging
					remembered = null
				}
			} catch (error) {
				delete plan.staging
				remembered = null
			}
		}

		const fileIds = await findSameNameStageFiles(plan, destinationCid, pendingFiles)
		if (fileIds.length === 0 && !remembered?.cid) return { fileIds: [] }

		let staging = await resolveStagingFolder(plan, destinationCid, destination, fileIds)
		if (remembered?.cid && !staging) {
			delete plan.staging
			await checkpoint()
			return { fileIds: [] }
		}
		if (!staging) {
			let name = stagingName(task)
			const existing = destination.find(item => folders.isFolder(item) && sameName(folders.nameOf(item), name))
			if (existing) {
				// If the worker stopped after createFolder but before the plan
				// checkpoint, reuse the deterministic orphan instead of leaving a
				// second temporary directory behind.
				staging = { version: 1, cid: folders.cidOf(existing), name, fileIds }
			} else {
				let suffix = 1
				while (destination.some(item => sameName(folders.nameOf(item), name))) name = `${stagingName(task)}_${suffix++}`
				const result = await api.createFolder(destinationCid, name)
				if (!api.operationSucceeded(result)) throw new Error('无法创建临时归档目录，稍后重试')
				const cid = String(result.cid || result.file_id || '')
				if (!cid || !await folders.child(destinationCid, cid)) throw new Error('临时归档目录创建尚未确认，稍后重试')
				staging = { version: 1, cid, name, fileIds }
			}
			plan.staging = staging
			// Persist before the first remote move. A worker restart can then find
			// the exact temporary directory and the explicit file IDs.
			await checkpoint()
		} else {
			plan.staging = staging
			if (!Array.isArray(plan.staging.fileIds) || plan.staging.fileIds.length === 0) plan.staging.fileIds = fileIds
			await checkpoint()
		}

		let stagedListing = await folders.read(staging.cid)
		const staged = new Set(stagedListing.items.filter(item => item.sha).map(fidOf))
		for (const fid of fileIds) {
			if (staged.has(fid)) continue
			if (destination.some(item => item.sha && fidOf(item) === fid)) continue
			const sourceFile = plan.files.find(file => String(file.fid) === fid)
			if (!sourceFile) throw new Error('暂存文件计划缺少明确文件 ID')
			const source = await folders.read(sourceFile.parentCid)
			if (!source.items.some(item => item.sha && fidOf(item) === fid)) throw new Error('暂存文件不在原位置，稍后重试')
			if (!api.operationSucceeded(await api.move(fid, staging.cid))) throw new Error('115 拒绝移动到临时目录')
			stagedListing = await folders.read(staging.cid)
			if (!stagedListing.items.some(item => item.sha && fidOf(item) === fid)) throw new Error('临时文件移动尚未确认，稍后重试')
			staged.add(fid)
			appendLog(task, '暂存文件：' + (sourceFile.name || fid))
			await checkpoint()
		}
		await restoreStagedFileNames(task, plan, staging.cid, fileIds, destinationCid, checkpoint, appendLog)

		// Remove now-empty source wrappers before moving staged files back. This
		// is the critical step for 115's same-name folder/file restriction.
		await removeEmptyPlannedFolders(task, plan, destinationCid, appendLog)
		await checkpoint()
		return { fileIds }
	}

	async function restoreStagedFileNames(task, plan, stagingCid, fileIds, destinationCid, checkpoint, appendLog) {
		let listing = await folders.read(stagingCid)
		for (const fid of fileIds) {
			const planned = plan.files.find(file => String(file.fid) === String(fid))
			if (!planned || !planned.name) continue
			const item = listing.items.find(entry => entry.sha && fidOf(entry) === String(fid))
			if (!item) {
				// A previous attempt may already have moved this file back to the
				// destination.  It no longer needs a rename in the staging folder.
				const destination = await folders.read(destinationCid)
				if (destination.items.some(entry => entry.sha && fidOf(entry) === String(fid))) continue
				throw new Error('临时目录缺少待恢复文件，稍后重试')
			}
			const currentName = folders.nameOf(item)
			if (currentName === planned.name) continue
			const conflict = listing.items.find(entry => entry.sha && fidOf(entry) !== String(fid) && sameName(folders.nameOf(entry), planned.name))
			if (conflict) throw new Error('恢复原文件名发生同名冲突：' + planned.name)
			if (!api.operationSucceeded(await api.rename(fid, planned.name))) throw new Error('恢复原文件名失败，稍后重试')
			listing = await folders.read(stagingCid)
			const restored = listing.items.find(entry => entry.sha && fidOf(entry) === String(fid))
			if (!restored || folders.nameOf(restored) !== planned.name) throw new Error('恢复原文件名尚未确认，稍后复核')
			appendLog(task, `恢复原文件名：${currentName} → ${planned.name}`)
			await checkpoint()
		}
	}

	async function restoreDestinationFileNames(task, plan, destinationCid, checkpoint, appendLog) {
		let listing = await folders.read(destinationCid)
		for (const planned of plan.files || []) {
			const fid = String(planned.fid || '')
			if (!fid || !planned.name) continue
			const item = listing.items.find(entry => entry.sha && fidOf(entry) === fid)
			if (!item || folders.nameOf(item) === planned.name) continue
			const conflict = listing.items.find(entry => folders.nameOf(entry) && fidOf(entry) !== fid && sameName(folders.nameOf(entry), planned.name))
			if (conflict) throw new Error('恢复原文件名发生同名冲突：' + planned.name)
			const currentName = folders.nameOf(item)
			if (!api.operationSucceeded(await api.rename(fid, planned.name))) throw new Error('恢复目标文件名失败，稍后重试')
			listing = await folders.read(destinationCid)
			const restored = listing.items.find(entry => entry.sha && fidOf(entry) === fid)
			if (!restored || folders.nameOf(restored) !== planned.name) throw new Error('恢复目标文件名尚未确认，稍后复核')
			appendLog(task, `恢复原文件名：${currentName} → ${planned.name}`)
			await checkpoint()
		}
	}

	async function removeEmptyPlannedFolders(task, plan, destinationCid, appendLog) {
		let retained = 0
		const parents = planFolderParents(plan)
		async function stillExists(cid) {
			if (cid === destinationCid) return true
			const parentCid = parents.get(cid)
			if (!parentCid || !await stillExists(parentCid)) return false
			return Boolean(await folders.child(parentCid, cid))
		}
		for (const folder of [...(plan.folders || [])].sort((a, b) => b.depth - a.depth)) {
			const cid = String(folder.cid)
			if (!await stillExists(cid)) continue
			const { items } = await folders.read(cid)
			if (items.length) { retained++; continue }
			if (!api.operationSucceeded(await api.remove(cid))) throw new Error('回收空任务目录失败，稍后重试')
			if (await folders.child(folder.parentCid, cid)) throw new Error('空目录回收尚未确认，稍后复核')
			appendLog(task, '已回收空任务目录 ' + cid)
		}
		return retained
	}

	async function cleanupStagingFolder(task, plan, destinationCid, appendLog) {
		const staging = plan.staging && typeof plan.staging === 'object' ? plan.staging : null
		if (!staging?.cid) return
		let listing
		try { listing = await folders.read(staging.cid) } catch (error) {
			delete plan.staging
			return
		}
		if (folders.pathCidOf(listing.path.at(-2)) !== destinationCid) {
			throw new Error('临时归档目录位置发生变化，暂停整理')
		}
		if (listing.items.length) return
		if (!await folders.child(destinationCid, staging.cid)) {
			delete plan.staging
			return
		}
		if (!api.operationSucceeded(await api.remove(staging.cid))) throw new Error('回收临时归档目录失败，稍后重试')
		if (await folders.child(destinationCid, staging.cid)) throw new Error('临时归档目录回收尚未确认，稍后复核')
		delete plan.staging
		appendLog(task, '已清理临时归档目录')
	}

	async function process(context) {
		if (global.Push115.AnimeSeries.needsFlatten(context.task)) return flattenBatchTask(context)
		return processors.generic.process(context)
	}
	processors.anime = { process, flattenBatchTask }
	processors.none = processors.anime
})(globalThis)
