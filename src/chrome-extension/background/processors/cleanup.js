;(function (global) {
	'use strict'
	const filesApi = global.Push115.Background.FilesApi
	const rulesApi = global.Push115.FileRules
	const processors = global.Push115.Background.Processors = global.Push115.Background.Processors || {}

	function getItemName(item) {
		return rulesApi.getFileName(item)
	}

	function getItemId(item) {
		const fid = item?.fid ?? item?.file_id ?? item?.fileId
		return fid === undefined || fid === null ? '' : String(fid)
	}

	function isFolder(item) {
		return Boolean(item && !item.sha && (item.cid || item.fid || item.file_id))
	}

	function buildRules(config = {}) {
		return rulesApi.buildRules({
			junkExtensions: config.push115_junk_extensions,
			preserveExtensions: config.push115_preserve_extensions,
			cleanExtensions: config.push115_clean_extensions,
			cleanImages: config.push115_clean_images === true,
			cleanNfo: config.push115_clean_nfo === true,
		})
	}

	async function cleanSmallFiles(cid, thresholdMB, rules = null) {
		const threshold = Number(thresholdMB)
		const thresholdBytes = Number.isFinite(threshold) && threshold > 0 ? threshold * 1024 * 1024 : 100 * 1024 * 1024
		const folderQueue = [String(cid || '0')]
		const visitedFolders = new Set()
		const collectedFiles = []

		while (folderQueue.length > 0) {
			const folderCid = folderQueue.shift()
			if (!folderCid || visitedFolders.has(folderCid)) continue
			visitedFolders.add(folderCid)
			const fileList = await filesApi.list(folderCid)
			if (!Array.isArray(fileList?.data)) continue
			for (const item of fileList.data) {
				if (isFolder(item)) {
					const childCid = String(item.cid || item.fid || item.file_id || '')
					if (childCid && !visitedFolders.has(childCid)) folderQueue.push(childCid)
				} else if (item?.sha) collectedFiles.push(item)
			}
		}

		const analyzed = rulesApi.analyzeFiles(collectedFiles, thresholdBytes, rules || rulesApi.buildRules())
		const candidates = analyzed.filter(entry => entry.decision.shouldDelete).map(entry => ({
			fid: getItemId(entry.item),
			name: getItemName(entry.item),
			reason: entry.decision.reason,
		})).filter(item => item.fid)
		for (let index = 0; index < candidates.length; index += 50) {
			const batch = candidates.slice(index, index + 50)
			const result = await filesApi.remove(batch.map(item => item.fid))
			if (!filesApi.operationSucceeded(result)) throw new Error('删除候选文件失败')
		}
		return { count: candidates.length, files: candidates, scannedFolders: visitedFolders.size }
	}

	processors.Helpers = { getItemName, getItemId, isFolder }
	processors.Cleanup = { buildRules, cleanSmallFiles }
})(globalThis)
