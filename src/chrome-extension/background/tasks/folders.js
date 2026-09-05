;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const api = background.FilesApi
	const cidOf = item => String(item?.cid || item?.fid || item?.file_id || '')
	const isFolder = item => Boolean(item && !item.sha && cidOf(item))
	const nameOf = item => String(item?.n || item?.name || '')
	const pathCidOf = item => String(item?.cid || item?.id || item?.file_id || item?.pid || '')

	// The /files endpoint can return a different directory for an invalid CID.
	// Require the returned breadcrumb to identify the requested folder before
	// using a listing to move files or infer that a folder is empty.
	async function read(cid) {
		cid = String(cid)
		if (!/^\d+$/.test(cid)) throw new Error('无效的整理目录 CID')
		const items = []
		const seen = new Set()
		let path = []
		for (let offset = 0; offset < 100000; ) {
			const result = await api.list(cid, offset)
			if (!api.operationSucceeded(result) || !Array.isArray(result.data)) throw new Error(`无法读取目录 ${cid}`)
			path = result.path
			if (!Array.isArray(path) || pathCidOf(path.at(-1)) !== cid) throw new Error(`目录 ${cid} 不存在或 115 返回了其他目录，请重新绑定`)
			const count = Number(result.count)
			if (!Number.isSafeInteger(count) || count < 0) throw new Error(`目录 ${cid} 返回的文件数量不完整`)
			for (const item of result.data) {
				const key = isFolder(item) ? `d:${cidOf(item)}` : `f:${item.fid || item.file_id}`
				if (seen.has(key)) throw new Error('目录分页发生变动，稍后重试')
				seen.add(key)
				items.push(item)
			}
			offset += result.data.length
			if (offset >= count) return { items, path }
			if (!result.data.length) throw new Error(`目录 ${cid} 分页未完整返回`)
		}
		throw new Error('目录过大，暂缓自动整理')
	}

	async function child(parentCid, cid) {
		return (await read(parentCid)).items.find(item => isFolder(item) && cidOf(item) === String(cid))
	}

	background.Folders = { read, child, cidOf, isFolder, nameOf, pathCidOf }
})(globalThis)
