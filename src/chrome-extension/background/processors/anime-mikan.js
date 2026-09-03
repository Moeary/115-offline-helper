;(function (global) {
	'use strict'

	const processors = global.Push115.Background.Processors
	const filesApi = global.Push115.Background.FilesApi
	const rulesApi = global.Push115.FileRules
	const anime = global.Push115.AnimeUtils
	const config = global.Push115.Config
	const { getItemName, getItemId, isFolder } = processors.Helpers

	function listItems(result) {
		if (Array.isArray(result?.data)) return result.data
		if (Array.isArray(result?.data?.data)) return result.data.data
		return []
	}

	async function listFolder(cid) {
		return listItems(await filesApi.list(String(cid || '0')))
	}

	function resultCid(result) {
		return String(
			result?.cid || result?.file_id || result?.fileId || result?.id ||
			result?.data?.cid || result?.data?.file_id || result?.data?.fileId || '',
		).trim()
	}

	function isFile(item) {
		return Boolean(item?.sha && getItemId(item))
	}

	function folderId(item) {
		return String(item?.cid || item?.file_id || item?.fileId || item?.fid || '').trim()
	}

	function isSubtitle(item) {
		return ['.srt', '.ass', '.ssa', '.sup', '.vtt'].includes(rulesApi.getExtension(getItemName(item)))
	}

	function sameName(left, right) {
		return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
	}

	function findFolder(items, name) {
		const wanted = String(name || '').trim().toLowerCase()
		// Unlike the legacy task-folder resolver, series grouping must not merge a
		// similarly named show by fuzzy match.  Only an exact folder name is safe.
		return items.find(item => isFolder(item) && sameName(getItemName(item), wanted))
	}

	async function findOrCreateSeriesFolder(parentCid, seriesName) {
		const parentItems = await listFolder(parentCid)
		const existing = findFolder(parentItems, seriesName)
		if (existing) return { cid: folderId(existing), created: false }
		const created = await filesApi.createFolder(parentCid, seriesName)
		let cid = resultCid(created)
		if (!cid) {
			const refreshed = await listFolder(parentCid)
			const found = findFolder(refreshed, seriesName)
			cid = found ? folderId(found) : ''
		}
		if (!cid) throw new Error(`创建番组目录失败：${seriesName}`)
		return { cid, created: true }
	}

	function taskSeriesKey(task) {
		return String(task?.metadata?.seriesKey || anime?.seriesKey(task?.metadata || {}) || '').trim().toLowerCase()
	}

	async function previousTasks(task) {
		const key = taskSeriesKey(task)
		if (!key || !global.chrome?.storage?.local) return []
		try {
			const stored = await chrome.storage.local.get(config.STORAGE_KEYS.TASKS)
			const records = stored[config.STORAGE_KEYS.TASKS]
			return (Array.isArray(records) ? records : [])
				.filter(item => item && item.taskId !== task.taskId && item.processorProfile === 'anime_mikan')
				.filter(item => taskSeriesKey(item) === key && item.status === 'completed')
				.sort((left, right) => Number(right.completedAt || right.updatedAt || 0) - Number(left.completedAt || left.updatedAt || 0))
		} catch (error) {
			return []
		}
	}

	function episodeForTask(task) {
		return anime?.normalizeEpisodeLabel(task?.metadata?.episode) ||
			anime?.extractEpisodeLabel(task?.remoteName, task?.title, task?.metadata?.title) || ''
	}

	function baseName(name) {
		const extension = rulesApi.getExtension(name)
		return String(name || '').slice(0, Math.max(0, String(name || '').length - extension.length))
	}

	function subtitleSuffix(name) {
		const base = baseName(name)
		const bracket = base.match(/(\[(?:简繁|简体|繁体|双语|CHS|CHT|ENG|JPN|SC|ZH|EN)[^\]]*\])$/i)
		if (bracket) return `-${bracket[1].replace(/[\[\]]/g, '')}`
		const suffix = base.match(/(?:^|[-_.\s])((?:cd|disc|disk|part)[-_.\s]?\d+|c|chs|cht|eng|jpn|sc|zh|en)$/i)
		return suffix ? `-${suffix[1].replace(/[-_.\s]+/g, '-').toUpperCase()}` : ''
	}

	function desiredSubtitleName(oldName, base) {
		return `${base}${subtitleSuffix(oldName)}${rulesApi.getExtension(oldName)}`
	}

	function desiredVideoName(seriesName, episodeLabel, multiple) {
		return multiple && episodeLabel ? `${seriesName}_${episodeLabel}` : seriesName
	}

	function hasName(items, name, exceptId = '') {
		return items.some(item => getItemId(item) !== exceptId && sameName(getItemName(item), name))
	}

	function belongsToSeries(name, seriesName) {
		const left = baseName(name).trim().toLowerCase()
		const right = String(seriesName || '').trim().toLowerCase()
		return left === right || left.startsWith(`${right}-`) || left.startsWith(`${right}_`) || left.startsWith(`${right} `)
	}

	async function renameSafely(item, name, knownItems) {
		const id = getItemId(item)
		const oldName = getItemName(item)
		if (!id || !name || oldName === name) return false
		if (hasName(knownItems, name, id)) return false
		const result = await filesApi.rename(id, name)
		return filesApi.operationSucceeded(result)
	}

	function isMikanDetailTask(task) {
		const pageUrl = task?.metadata?.mikanBangumiUrl || task?.metadata?.pageUrl
		return task?.metadata?.mikanDetail === true && Boolean(anime?.isMikanBangumiUrl(pageUrl))
	}

	async function process(context) {
		const { task, targetCid, folderResolved, appendLog } = context
		const messages = await processors.anime.process(context)
		if (!isMikanDetailTask(task)) {
			appendLog(task, 'Anime · Mikan 仅对明确的 Mikan 番组详情页生效，本次保留原名')
			return messages
		}
		if (!folderResolved) {
			appendLog(task, '未定位独立下载目录，为避免误动其他任务，本次未执行番组归拢')
			return messages
		}

		const metadata = task.metadata || {}
		const seriesName = anime?.sanitizeSeriesName(metadata.seriesTitle || metadata.animeTitle || metadata.title || task.title || task.remoteName)
		const episodeLabel = episodeForTask(task)
		const parentCid = String(task.savePathCid || '0')
		const targetItems = await listFolder(targetCid)
		const currentFiles = targetItems.filter(isFile)
		const currentVideos = currentFiles.filter(rulesApi.isVideo).sort((left, right) => rulesApi.getSizeBytes(right) - rulesApi.getSizeBytes(left))
		const currentSubtitles = currentFiles.filter(isSubtitle)
		const currentIds = new Set(currentFiles.map(getItemId).filter(Boolean))
		if (currentVideos.length === 0 && currentSubtitles.length === 0) {
			appendLog(task, '下载目录没有可归拢的视频或字幕，保留原目录结构')
			return messages
		}

		const targetName = String(task.folderName || task.remoteName || '').trim()
		let seriesCid = ''
		if (sameName(targetName, seriesName)) seriesCid = String(targetCid)
		else seriesCid = (await findOrCreateSeriesFolder(parentCid, seriesName)).cid
		if (!seriesCid) throw new Error(`找不到番组目录：${seriesName}`)

		let seriesItems = await listFolder(seriesCid)
		const existingVideos = seriesItems.filter(item => isFile(item) && rulesApi.isVideo(item) && !currentIds.has(getItemId(item)))
		const previous = await previousTasks(task)
		const totalVideoCount = existingVideos.length + currentVideos.length
		const multipleEpisodes = totalVideoCount > 1
		const oldSingle = existingVideos.find(item => sameName(baseName(getItemName(item)), seriesName))
		if (multipleEpisodes && oldSingle) {
			const previousEpisode = previous.map(episodeForTask).find(Boolean)
			if (previousEpisode) {
				const oldName = getItemName(oldSingle)
				const oldTarget = `${seriesName}_${previousEpisode}${rulesApi.getExtension(oldName)}`
				try {
					if (await renameSafely(oldSingle, oldTarget, seriesItems)) appendLog(task, `补齐上一集文件名 → ${oldTarget}`)
				} catch (error) {
					appendLog(task, `上一集文件改名失败：${error?.message || error}`)
				}
				const oldSubtitleBase = `${seriesName}_${previousEpisode}`
				for (const subtitle of seriesItems.filter(item => isFile(item) && isSubtitle(item) && !currentIds.has(getItemId(item)) && belongsToSeries(getItemName(item), seriesName))) {
					const subtitleTarget = desiredSubtitleName(getItemName(subtitle), oldSubtitleBase)
					try {
						if (await renameSafely(subtitle, subtitleTarget, seriesItems)) appendLog(task, `补齐上一集字幕 → ${subtitleTarget}`)
					} catch (error) {
						appendLog(task, `上一集字幕改名失败：${error?.message || error}`)
					}
				}
			}
		}

		if (String(seriesCid) !== String(targetCid)) {
			for (const item of [...currentFiles]) {
				try {
					const moved = await filesApi.move(getItemId(item), seriesCid)
					if (!filesApi.operationSucceeded(moved)) appendLog(task, `移动失败：${getItemName(item)}`)
				} catch (error) {
					appendLog(task, `移动失败：${getItemName(item)}（${error?.message || error}）`)
				}
			}
			seriesItems = await listFolder(seriesCid)
		} else {
			seriesItems = targetItems
		}

		const finalVideos = seriesItems.filter(item => isFile(item) && rulesApi.isVideo(item))
		// A range such as [01-06 END] is one torrent but represents several
		// episodes, so keep its range label instead of collapsing it to 番名.ext.
		const finalMultiple = finalVideos.length > 1 || /\d+-\d+/.test(episodeLabel)
		const currentMainId = currentVideos[0] ? getItemId(currentVideos[0]) : ''
		const currentMain = finalVideos.find(item => getItemId(item) === currentMainId)
		const videoBase = desiredVideoName(seriesName, episodeLabel, finalMultiple)
		if (currentMain && videoBase && episodeLabel) {
			const oldName = getItemName(currentMain)
			const newName = `${videoBase}${rulesApi.getExtension(oldName)}`
			try {
				if (await renameSafely(currentMain, newName, seriesItems)) messages.push(`主视频 → ${newName}`)
			} catch (error) {
				appendLog(task, `主视频改名失败：${error?.message || error}`)
			}
		}

		if (episodeLabel) {
			seriesItems = await listFolder(seriesCid)
			for (const subtitle of seriesItems.filter(item => currentIds.has(getItemId(item)) && isSubtitle(item))) {
				const newName = desiredSubtitleName(getItemName(subtitle), videoBase)
				try {
					if (await renameSafely(subtitle, newName, seriesItems)) messages.push(`字幕 → ${newName}`)
				} catch (error) {
					appendLog(task, `字幕改名失败：${error?.message || error}`)
				}
			}
		}

		if (seriesCid !== targetCid) messages.push(`归拢到番组目录：${seriesName}`)
		if (!episodeLabel) appendLog(task, '未识别集号，已归拢但保留资源原名以避免误改')
		else appendLog(task, `Anime · Mikan 整理完成：${seriesName}${finalMultiple ? `_${episodeLabel}` : ''}`)
		return messages
	}

	processors.anime_mikan = { process }
})(globalThis)
