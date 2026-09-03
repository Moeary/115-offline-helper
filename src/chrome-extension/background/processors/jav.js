;(function (global) {
	'use strict'
	const processors = global.Push115.Background.Processors
	const filesApi = global.Push115.Background.FilesApi
	const rulesApi = global.Push115.FileRules
	const intentApi = global.Push115.DownloadIntent
	const { getItemName, getItemId, isFolder } = processors.Helpers

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

	processors.jav = { process, organizeKnownTaskFolder, organizeVideos }
})(globalThis)
