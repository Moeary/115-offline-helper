;(function (global) {
	'use strict'
	const background = global.Push115.Background
	const api = background.FilesApi
	const cidOf = item => String(item?.cid || item?.id || item?.folder_id || item?.fid || item?.file_id || item?.fileId || '')
	const fileIdOf = item => String(item?.fid || item?.file_id || item?.fileId || item?.id || '')
	const isFolder = item => Boolean(item && !item.sha && cidOf(item))
	const nameOf = item => String(item?.n || item?.name || item?.file_name || '')
	const pathCidOf = item => String(item?.cid || item?.id || item?.folder_id || item?.fid || item?.file_id || item?.fileId || item?.pid || item?.parent_cid || '')
	const PAGE_SIZE = 500

	function responseItems(result) {
		if (Array.isArray(result?.data)) return result.data
		if (Array.isArray(result?.data?.list)) return result.data.list
		if (Array.isArray(result?.list)) return result.list
		return null
	}

	function responsePath(result, cid) {
		const candidates = [result?.path, result?.path_info, result?.pathInfo, result?.breadcrumb]
		const path = candidates.find(value => Array.isArray(value))
		if (!path) {
			// The root listing is still safe to consume without a breadcrumb: its
			// CID is fixed and it cannot silently point at another folder.
			return cid === '0' ? [{ cid: '0', n: '根目录' }] : null
		}
		const ids = path.map(pathCidOf).filter(Boolean)
		if (ids.at(-1) === cid) return path
		// Some 115 responses have appeared in current-folder-first order.  Only
		// reverse when the first breadcrumb is an exact CID match; never accept a
		// path that merely contains the requested CID as an ancestor.
		if (ids[0] === cid) return path.slice().reverse()
		return null
	}

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
			const pageItems = responseItems(result)
			if (!api.operationSucceeded(result) || !pageItems) {
				const diagnostics = typeof api.responseDiagnostics === 'function'
					? api.responseDiagnostics(result, cid)
					: { cid: String(cid) }
				console.warn('[115 FilesApi] list response diagnostic', diagnostics)
				throw new Error(`无法读取目录 ${cid}`)
			}
			path = responsePath(result, cid)
			if (!path) throw new Error(`目录 ${cid} 不存在或 115 返回了其他目录，请重新绑定`)
			const rawCount = result.count ?? result.total ?? result.total_count
			const count = rawCount === undefined || rawCount === null || rawCount === '' ? null : Number(rawCount)
			if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error(`目录 ${cid} 返回了不完整的数量信息`)
			for (const item of pageItems) {
				const itemId = isFolder(item) ? cidOf(item) : fileIdOf(item)
				// Ignore malformed records rather than turning every valid directory
				// listing into a duplicate "undefined" file.  All later mutations
				// still require an explicit, validated FID/CID.
				if (!itemId) continue
				const key = isFolder(item) ? `d:${itemId}` : `f:${itemId}`
				if (seen.has(key)) throw new Error('目录分页发生变动，稍后重试')
				seen.add(key)
				items.push(item)
			}
			offset += pageItems.length
			if (count !== null && offset >= count) return { items, path }
			if (!pageItems.length) return { items, path }
			if (count === null && pageItems.length < PAGE_SIZE) return { items, path }
		}
		throw new Error('目录过大，暂缓自动整理')
	}

	async function child(parentCid, cid) {
		return (await read(parentCid)).items.find(item => isFolder(item) && cidOf(item) === String(cid))
	}

	background.Folders = { read, child, cidOf, isFolder, nameOf, pathCidOf }
})(globalThis)
