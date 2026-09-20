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
	const READ_RETRY_ATTEMPTS = 3
	const READ_RETRY_BACKOFF_MS = 250

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
	async function readOnce(cid) {
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

	// A transient 115 response can contain a false state, an incomplete
	// breadcrumb, or the root listing for a short period. Retry only the
	// validated read; never substitute the returned root or scan the library.
	async function read(cid) {
		const value = String(cid)
		if (!/^\d+$/.test(value)) throw new Error('无效的整理目录 CID')
		let lastError
		for (let attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1) {
			try {
				return await readOnce(value)
			} catch (error) {
				lastError = error
				if (attempt < READ_RETRY_ATTEMPTS) {
					await new Promise(resolve => setTimeout(resolve, READ_RETRY_BACKOFF_MS * attempt))
				}
			}
		}
		throw lastError || new Error(`无法读取目录 ${value}`)
	}

	async function child(parentCid, cid) {
		return (await read(parentCid)).items.find(item => isFolder(item) && cidOf(item) === String(cid))
	}

	background.Folders = {
		read,
		child,
		cidOf,
		isFolder,
		nameOf,
		pathCidOf,
		READ_RETRY_POLICY: Object.freeze({ attempts: READ_RETRY_ATTEMPTS, backoffMs: READ_RETRY_BACKOFF_MS }),
	}
})(globalThis)
