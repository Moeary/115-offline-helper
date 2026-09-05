;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const { STORAGE_KEYS } = global.Push115.Config
	const seriesApi = global.Push115.AnimeSeries
	const folders = background.Folders
	const api = background.FilesApi
	const pathCidOf = folders.pathCidOf || (item => String(item?.cid || item?.id || item?.file_id || ''))
	const pathNameOf = item => String(item?.name || item?.n || item?.file_name || '')
	let chain = Promise.resolve()

	function exclusive(work) {
		const result = chain.catch(() => {}).then(work)
		chain = result
		return result
	}

	async function read() {
		const data = await chrome.storage.local.get(STORAGE_KEYS.ANIME_LIBRARY)
		return data[STORAGE_KEYS.ANIME_LIBRARY] || {}
	}

	async function get(key) {
		return (await read())[key] || null
	}

	async function prepare(details) {
		return exclusive(async () => {
			const series = seriesApi.normalize(details.series)
			if (!series) throw new Error('缺少明确的 Mikan 番组信息')
			const records = await read()
			const previous = records[series.key]
			if ((previous?.cid || '') !== (details.expectedCid || '')) throw new Error('本番目录已在其他窗口修改，请重新打开确认窗口')
			let cid, name, parentCid
			if (details.mode === 'reuse') {
				if (!previous) throw new Error('尚未绑定本番目录')
				cid = previous.cid
				name = previous.name
				parentCid = previous.parentCid
				await folders.read(cid)
			} else if (details.mode === 'bind') {
				cid = global.Push115.Config.normalizeCid(details.cid, '')
				const result = await folders.read(cid)
				name = pathNameOf(result.path.at(-1)) || series.title
				parentCid = pathCidOf(result.path.at(-2)) || '0'
			} else if (details.mode === 'create') {
				parentCid = global.Push115.Config.normalizeCid(details.cid, '')
				name = seriesApi.folderName(details.folderName)
				if (!name || name !== String(details.folderName).trim()) throw new Error('目录名称为空或含不支持的字符，请修改后提交')
				const items = (await folders.read(parentCid)).items
				const matches = items.filter(item => folders.isFolder(item) && folders.nameOf(item) === name)
				if (matches.length > 1) throw new Error('存在多个同名目录，请从保存目录列表明确选择一个')
				cid = matches[0] && folders.cidOf(matches[0])
				if (!cid) {
					const result = await api.createFolder(parentCid, name)
					if (!api.operationSucceeded(result)) throw new Error('创建番组目录失败')
					cid = String(result.cid || result.file_id || '')
				}
				if (!await folders.child(parentCid, cid)) throw new Error('无法核实新建番组目录，请稍后重新提交')
				await folders.read(cid)
			} else throw new Error('不支持的番组归档方式')
			// Independent of task logs; clearing history must not forget where EP09 belongs.
			const binding = { ...series, cid, name, parentCid, updatedAt: Date.now(), submissions: previous?.submissions || {} }
			records[series.key] = binding
			await chrome.storage.local.set({ [STORAGE_KEYS.ANIME_LIBRARY]: records })
			return { seriesKey: series.key, cid, name }
		})
	}

	async function validateTarget(intent) {
		const target = intent.metadata?.animeTarget
		const series = seriesApi.normalize(intent.metadata?.series)
		if (!series || target?.seriesKey !== series.key || target.cid !== intent.savePathCid) throw new Error('番组目标与下载目录不一致，请重新确认')
		const binding = await get(series.key)
		if (binding?.cid !== target.cid) throw new Error('本番目录已变更，请重新确认')
		await folders.read(target.cid)
		return binding
	}

	async function recordSubmission(intent, taskId) {
		return exclusive(async () => {
			const records = await read()
			const key = intent.metadata.animeTarget.seriesKey
			const binding = records[key]
			if (!binding) return
			if (!binding.submissions || typeof binding.submissions !== 'object') binding.submissions = {}
			const hash = global.Push115.DownloadIntent.dedupeKey(intent.url)
			binding.submissions[hash] = { cid: intent.savePathCid, taskId, at: Date.now() }
			// Bounded receipt history; bindings themselves are never evicted.
			binding.submissions = Object.fromEntries(Object.entries(binding.submissions).sort((a, b) => b[1].at - a[1].at).slice(0, 2000))
			await chrome.storage.local.set({ [STORAGE_KEYS.ANIME_LIBRARY]: records })
		})
	}

	background.AnimeLibrary = { get, prepare, validateTarget, recordSubmission }
})(globalThis)
