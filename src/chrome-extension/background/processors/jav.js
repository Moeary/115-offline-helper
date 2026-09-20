;(function (global) {
	'use strict'
	const processors = global.Push115.Background.Processors
	const filesApi = global.Push115.Background.FilesApi
	const rulesApi = global.Push115.FileRules
	const intentApi = global.Push115.DownloadIntent
	const { getItemName, getItemId, isFolder } = processors.Helpers
	const foldersApi = global.Push115.Background.Folders
	const RENAME_RETRY_ATTEMPTS = 3
	const RENAME_RETRY_BACKOFF_MS = 300

	function normalizeCompareCode(value) {
		return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
	}

	function buildSubtitleName(rawName, code) {
		const name = String(rawName || '')
		const extension = rulesApi.getExtension(name)
		const base = name.slice(0, Math.max(0, name.length - extension.length))
		if (normalizeCompareCode(base).includes(normalizeCompareCode(code))) return name
		const suffixMatch = base.match(/(?:^|[-_.\s])((?:cd|disc|part)[-_.\s]?\d+|c|chs|cht|eng|jpn|sc|zh|en)$/i)
		const suffix = suffixMatch ? `-${suffixMatch[1].replace(/[-_.\s]+/g, '-').toUpperCase()}` : ''
		return `${code}${suffix}${extension}`
	}

	function isSubtitle(item) {
		return ['.srt', '.ass', '.ssa', '.sup', '.vtt'].includes(rulesApi.getExtension(getItemName(item)))
	}

	function folderCid(item) {
		return String(item?.cid || item?.fid || item?.file_id || '').trim()
	}

	function directExpected(task) {
		const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}
		const size = String(task?.expectedSize ?? metadata.expectedSize ?? metadata.ed2kSize ?? '').replace(/\s+/g, '').trim()
		return {
			name: String(task?.expectedName || metadata.expectedName || metadata.ed2kFileName || '').trim(),
			size: /^\d+$/.test(size) ? Number(size) : 0,
			hash: String(task?.expectedHash || metadata.expectedHash || metadata.ed2kHash || '').trim().toLowerCase(),
		}
	}

	function isSouthPlusFlat(task) {
		const source = String(task?.sourceSite || task?.source || '').trim().toLowerCase()
		let linkType = String(task?.linkType || task?.metadata?.linkType || '').trim().toLowerCase()
		if (!linkType) {
			try { linkType = String(intentApi.parseDownloadLink?.(task?.url || task?.magnet)?.linkType || '').trim().toLowerCase() } catch (error) { /* legacy task */ }
		}
		return source === 'southplus' && linkType === 'ed2k'
	}

	function directFileMatches(item, task) {
		if (!item?.sha) return false
		const expected = directExpected(task)
		const plannedName = String(task?.directPlan?.targetName || '').trim()
		const namesMatch = !expected.name
			|| intentApi.downloadNamesMatch?.(getItemName(item), expected.name)
			|| (plannedName && intentApi.downloadNamesMatch?.(getItemName(item), plannedName))
		if (expected.name && !namesMatch) {
			const expectedCode = intentApi.normalizeCode(task?.metadata?.pageCode)
				|| intentApi.normalizeCode(task?.code)
				|| intentApi.extractVideoCode?.(expected.name)
			const actualCode = intentApi.extractVideoCode?.(getItemName(item))
			const actualSize = rulesApi.getSizeBytes(item)
			const actualHash = String(item?.hash || item?.ed2kHash || item?.file_hash || item?.content_hash || '').trim().toLowerCase()
			const sameHash = Boolean(expected.hash && actualHash && actualHash === expected.hash)
			const sameCodeAndSize = Boolean(expectedCode && actualCode && expectedCode === actualCode
				&& expected.size > 0 && actualSize === expected.size)
			if (!sameHash && !sameCodeAndSize) return false
		}
		if (expected.size > 0 && rulesApi.getSizeBytes(item) !== expected.size) return false
		if (expected.hash) {
			const actual = String(item?.hash || item?.ed2kHash || item?.file_hash || item?.content_hash || '').trim().toLowerCase()
			if (actual && actual !== expected.hash) return false
			if (!actual && String(item?.sha || '').trim().toLowerCase() === expected.hash) return true
		}
		return true
	}

	async function readValidatedFolder(cid) {
		const value = String(cid || '').trim()
		if (!value) throw new Error('缺少单文件源目录 CID')
		if (foldersApi?.read) return foldersApi.read(value)
		const result = await filesApi.list(value)
		if (!Array.isArray(result?.data)) throw new Error(`无法读取目录 ${value}`)
		return { items: result.data, path: result.path }
	}

	function exactFolder(items, name) {
		const wanted = String(name || '').trim().toLowerCase()
		if (!wanted) return null
		const matches = (Array.isArray(items) ? items : []).filter(item => isFolder(item) && getItemName(item).toLowerCase() === wanted)
		if (matches.length > 1) throw new Error(`JAV 目标目录 ${name} 存在同名冲突`)
		return matches[0] || null
	}

	function findNameCollision(items, fid, names) {
		const wanted = new Set(names.map(name => String(name || '').trim().toLowerCase()).filter(Boolean))
		if (wanted.size === 0) return null
		return (Array.isArray(items) ? items : []).find(item => getItemId(item) !== String(fid)
			&& wanted.has(getItemName(item).trim().toLowerCase())) || null
	}

	async function verifyFile(cid, fid, task) {
		const listing = await readValidatedFolder(cid)
		const item = (Array.isArray(listing?.items) ? listing.items : []).find(value => getItemId(value) === String(fid))
		if (!item || !item.sha || !directFileMatches(item, task)) throw new Error('JAV 单文件复核失败，保留文件等待重试')
		return { listing, item }
	}

	async function renameWithRetry(cid, fid, name, task) {
		let lastError
		for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt += 1) {
			try {
				const result = await filesApi.rename(fid, name)
				if (filesApi.operationSucceeded(result)) return result
				lastError = new Error('115 拒绝重命名 JAV 单文件')
			} catch (error) {
				lastError = error
			}
			if (attempt < RENAME_RETRY_ATTEMPTS) {
				await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_BACKOFF_MS * attempt))
			}
		}
		throw lastError || new Error('115 拒绝重命名 JAV 单文件')
	}

	async function removeEmptySouthPlusFolder(sourceCid, parentCid, appendLog) {
		if (!sourceCid || !parentCid || sourceCid === parentCid || typeof foldersApi?.child !== 'function') return false
		if (!await foldersApi.child(parentCid, sourceCid)) return false
		const listing = await readValidatedFolder(sourceCid)
		if ((Array.isArray(listing?.items) ? listing.items : []).length !== 0) return false
		const removed = await filesApi.remove(sourceCid)
		if (!filesApi.operationSucceeded(removed)) throw new Error('115 拒绝清理空的 South Plus 任务目录')
		if (await foldersApi.child(parentCid, sourceCid)) throw new Error('空的 South Plus 任务目录回收尚未确认')
		appendLog?.('已清理空的 South Plus 任务目录')
		return true
	}

	async function processDirect(context) {
		const { task, targetCid, config, appendLog, checkpoint = () => {} } = context
		const plan = task.directPlan && typeof task.directPlan === 'object' ? task.directPlan : {}
		const flatSouthPlus = isSouthPlusFlat(task)
		const fid = String(task.directFileId || task.directFid || plan.fid || getItemId(context.targetFile) || '').trim()
		if (!fid) throw new Error('缺少明确的单文件 FID')
		const sourceCid = String((flatSouthPlus ? task.directFileCid || plan.currentCid || plan.sourceCid : plan.sourceCid || task.directFileCid)
			|| targetCid || '').trim()
		let currentCid = String((flatSouthPlus ? task.directFileCid || plan.currentCid || (plan.moved && plan.destinationCid) : plan.currentCid || (plan.moved && plan.destinationCid))
			|| sourceCid).trim()
		const initialCurrentCid = currentCid
		let verified
		try {
			verified = await verifyFile(currentCid, fid, task)
		} catch (error) {
			// The move may have succeeded immediately before a worker checkpoint.
			// A persisted plan can therefore still point at the old source CID;
			// verify the recorded destination before asking the user to retry.
			const recordedDestination = String(plan.destinationCid || '').trim()
			if (!recordedDestination || recordedDestination === currentCid) throw error
			verified = await verifyFile(recordedDestination, fid, task)
			currentCid = recordedDestination
			task.directPlan = { ...plan, currentCid, moved: true }
			await checkpoint()
		}
		let item = verified.item
		const code = intentApi.normalizeCode(task.metadata?.pageCode) || intentApi.normalizeCode(task.code)
		if (config.push115_auto_organize !== true || !code) {
			appendLog(task, code ? `已确认 ${code} 单文件，保留原目录与文件名` : '已确认单文件，未取得可执行的番号')
			return []
		}

		const extension = rulesApi.getExtension(getItemName(item))
		const targetName = `${code}${extension}`
		const existingPlan = {
			...plan,
			version: 1,
			fid,
			sourceCid,
			currentCid,
			destinationCid: flatSouthPlus ? String(targetCid).trim() : String(plan.destinationCid || '').trim(),
			originalName: String(plan.originalName || getItemName(item)).trim(),
			targetName,
			code,
			moved: Boolean(plan.moved),
			renamed: Boolean(plan.renamed),
			finished: false,
		}
		task.directPlan = { ...existingPlan, fid, sourceCid, currentCid, targetName, code }
		await checkpoint()

		let destinationCid = flatSouthPlus ? String(targetCid).trim() : String(task.directPlan.destinationCid || '').trim()
		if (!destinationCid) {
			const parent = await readValidatedFolder(targetCid)
			const destination = exactFolder(parent.items, code)
			if (destination) destinationCid = folderCid(destination)
			else {
				const created = await filesApi.createFolder(targetCid, code)
				if (!filesApi.operationSucceeded(created)) throw new Error('创建 JAV 番号目录失败')
				const refreshed = await readValidatedFolder(targetCid)
				const candidates = (Array.isArray(refreshed?.items) ? refreshed.items : [])
					.filter(value => isFolder(value) && getItemName(value).toLowerCase() === code.toLowerCase())
				if (candidates.length !== 1) throw new Error('创建后无法唯一确认 JAV 番号目录')
				destinationCid = folderCid(candidates[0])
			}
			if (!destinationCid) throw new Error('JAV 番号目录缺少 CID')
			task.directPlan.destinationCid = destinationCid
			await checkpoint()
		}

		await readValidatedFolder(destinationCid)
		if (currentCid !== destinationCid) {
			const destination = await readValidatedFolder(destinationCid)
			const originalName = String(task.directPlan.originalName || getItemName(item)).trim()
			const collision = findNameCollision(destination?.items, fid, [targetName, originalName])
			if (collision) throw new Error(`JAV 目标文件名冲突：${getItemName(collision)}`)
			const moved = await filesApi.move(fid, destinationCid)
			if (!filesApi.operationSucceeded(moved)) throw new Error('115 拒绝移动 JAV 单文件')
			const afterMove = await verifyFile(destinationCid, fid, task)
			currentCid = destinationCid
			item = afterMove.item
			task.directPlan.currentCid = currentCid
			task.directPlan.moved = true
			await checkpoint()
		}

		if (getItemName(item) !== targetName) {
			const destination = await readValidatedFolder(destinationCid)
			const collision = findNameCollision(destination?.items, fid, [targetName])
			if (collision) throw new Error(`JAV 目标文件名冲突：${targetName}`)
			const renamed = await renameWithRetry(destinationCid, fid, targetName, task)
			const afterRename = await verifyFile(destinationCid, fid, task)
			item = afterRename.item
			task.directPlan.renamed = true
			await checkpoint()
		}

		const final = await verifyFile(destinationCid, fid, task)
		if (getItemName(final.item) !== targetName) throw new Error('JAV 单文件重命名复核失败')
		if (flatSouthPlus) await removeEmptySouthPlusFolder(initialCurrentCid, destinationCid, appendLog)
		task.directPlan.currentCid = destinationCid
		task.directPlan.finished = true
		await checkpoint()
		const messages = []
		if (task.directPlan.moved) messages.push(flatSouthPlus ? `单文件平铺 → ${code}` : `单文件 → ${code}`)
		if (task.directPlan.renamed) messages.push(`主视频 → ${targetName}`)
		appendLog(task, `按 ${code} 完成单文件整理`)
		return messages
	}

	async function organizeKnownTaskFolder(cid, task) {
		const list = await filesApi.list(cid)
		if (!Array.isArray(list?.data)) return { count: 0, main: '', subtitles: 0, folderRenamed: false }
		// Adapter 提取出的页面番号已经写入 task.code，始终优先于远端文件名。
		const code = intentApi.normalizeCode(task.metadata?.pageCode) || intentApi.normalizeCode(task.code)
		if (!code) return { count: 0, main: '', subtitles: 0, folderRenamed: false }
		const files = list.data.filter(item => item?.sha)
		const videos = files.filter(rulesApi.isVideo).sort((left, right) => rulesApi.getSizeBytes(right) - rulesApi.getSizeBytes(left))
		let count = 0
		let main = ''
		if (videos.length > 0) {
			const mainVideo = videos[0]
			const oldName = getItemName(mainVideo)
			const newName = `${code}${rulesApi.getExtension(oldName)}`
			main = newName
			if (oldName !== newName && filesApi.operationSucceeded(await filesApi.rename(getItemId(mainVideo), newName))) count += 1
		}
		let subtitles = 0
		for (const subtitle of files.filter(isSubtitle)) {
			const oldName = getItemName(subtitle)
			const newName = buildSubtitleName(oldName, code)
			if (oldName === newName) continue
			if (filesApi.operationSucceeded(await filesApi.rename(getItemId(subtitle), newName))) {
				subtitles += 1
				count += 1
			}
		}
		let folderRenamed = false
		if (String(cid) !== '0') {
			try {
				folderRenamed = filesApi.operationSucceeded(await filesApi.rename(cid, code))
			} catch (error) {
				console.warn('[BG] 任务文件夹改名失败:', error?.message || error)
			}
		}
		return { count, main, subtitles, folderRenamed, code }
	}

	async function organizeVideos(cid) {
		const list = await filesApi.list(cid)
		if (!Array.isArray(list?.data)) return 0
		const videos = list.data.filter(item => item?.sha && rulesApi.isVideo(item))
		let count = 0
		for (const video of videos) {
			const code = intentApi.normalizeCode(getItemName(video))
			if (!code) continue
			let targetCid = ''
			const existing = list.data.find(item => isFolder(item) && normalizeCompareCode(getItemName(item)) === normalizeCompareCode(code))
			if (existing) targetCid = String(existing.cid || existing.fid || existing.file_id || '')
			else {
				const result = await filesApi.createFolder(cid, code)
				targetCid = String(result?.cid || result?.file_id || '')
			}
			if (targetCid && filesApi.operationSucceeded(await filesApi.move(getItemId(video), targetCid))) count += 1
		}
		return count
	}

	async function process(context) {
		const { task, targetCid, folderResolved, config, appendLog } = context
		const messages = await processors.generic.process(context)
		if (config.push115_auto_organize !== true) return messages
		const code = intentApi.normalizeCode(task.metadata?.pageCode) || intentApi.normalizeCode(task.code)
		if (code && folderResolved) {
			const result = await organizeKnownTaskFolder(targetCid, task)
			if (result.main) messages.push(`主视频 → ${result.main}`)
			if (result.subtitles > 0) messages.push(`整理 ${result.subtitles} 个字幕`)
			if (result.folderRenamed) messages.push(`文件夹 → ${code}`)
			appendLog(task, `按 ${code} 整理完成`)
		} else if (!code) {
			const count = await organizeVideos(targetCid)
			if (count > 0) messages.push(`整理 ${count} 个视频`)
			appendLog(task, `未取得页面番号，按文件名整理 ${count} 个视频`)
		} else {
			appendLog(task, `已记录番号 ${code}，但未定位到独立任务文件夹；为避免误动其他任务，本次未移动文件`)
		}
		return messages
	}

	processors.jav = { process, processDirect, organizeKnownTaskFolder, organizeVideos }
})(globalThis)
