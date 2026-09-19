;(function (global) {
	'use strict'

	const push115 = global.Push115 = global.Push115 || {}
	const background = push115.Background = push115.Background || {}
	const config = push115.Config || {}
	const storageKey = config.STORAGE_KEYS?.DIRECTORY_INDEX || 'push115_directory_index'
	const CID_PATTERN = /^\d{1,64}$/
	const MAX_ROOTS = 32
	const MAX_DIRECTORIES = 4000
	const MAX_REQUESTS = 5000
	const MAX_DURATION_MS = 5 * 60 * 1000
	const MAX_DEPTH = 32
	const MAX_NAME_LENGTH = 256
	const MAX_PATH_LENGTH = 4096
	let scanChain = Promise.resolve()

	function storage() {
		return chrome.storage?.local
	}

	function normalizeCid(value) {
		const cid = String(value ?? '').trim()
		return CID_PATTERN.test(cid) ? cid : ''
	}

	function normalizeName(value) {
		const name = String(value ?? '').trim()
		if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return ''
		if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return ''
		return name
	}

	function normalizePath(value) {
		let path = String(value ?? '').trim().replaceAll('\\', '/')
		if (!path) return ''
		if (!path.startsWith('/')) path = `/${path}`
		path = path.replace(/\/+/g, '/').replace(/\/+$/, '')
		if (!path || path === '/') return ''
		if (path.length > MAX_PATH_LENGTH || path.slice(1).split('/').some(segment => !segment || segment === '.' || segment === '..')) return ''
		if (/[\u0000-\u001f\u007f]/.test(path)) return ''
		return path
	}

	function joinPath(parentPath, name) {
		const normalizedName = normalizeName(name)
		if (!normalizedName) return ''
		const base = normalizePath(parentPath)
		return `${base}/${normalizedName}`.replace(/\/+/g, '/')
	}

	function clampDepth(value, fallback = 1) {
		const depth = Number(value)
		if (!Number.isSafeInteger(depth)) return fallback
		return Math.max(1, Math.min(MAX_DEPTH, depth))
	}

	function normalizeRoots(value) {
		const values = Array.isArray(value) ? value : [value]
		const roots = []
		const seen = new Set()
		for (const item of values) {
			const cid = normalizeCid(item)
			if (!cid || seen.has(cid)) continue
			seen.add(cid)
			roots.push(cid)
			if (roots.length >= MAX_ROOTS) break
		}
		return roots.length > 0 ? roots : ['0']
	}

	function breadcrumbPath(path, cid) {
		const target = normalizeCid(cid)
		if (!target || target === '0' || !Array.isArray(path)) return ''
		const names = []
		for (const item of path) {
			const itemCid = String(background.Folders?.pathCidOf?.(item) || item?.cid || item?.id || '').trim()
			if (itemCid === '0') continue
			const name = normalizeName(background.Folders?.nameOf?.(item) || item?.name || item?.n || '')
			if (name) names.push(name)
			if (itemCid === target) break
		}
		return names.length > 0 ? `/${names.join('/')}` : ''
	}

	function normalizeIndex(value) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
		const rawDirectories = Array.isArray(source.directories) ? source.directories : []
		const directories = []
		const seenCids = new Set()
		const seenPaths = new Set()
		for (const raw of rawDirectories) {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
			const cid = normalizeCid(raw.cid)
			const name = normalizeName(raw.name)
			const path = normalizePath(raw.path) || (name ? `/${name}` : '')
			if (!cid || cid === '0' || !name || !path || seenCids.has(cid) || seenPaths.has(path)) continue
			const parentCid = normalizeCid(raw.parentCid ?? raw.parent_cid) || '0'
			const rawDepth = Number(raw.depth)
			const depth = Number.isSafeInteger(rawDepth) && rawDepth >= 1
				? Math.min(MAX_DEPTH, rawDepth)
				: Math.min(MAX_DEPTH, Math.max(1, path.split('/').filter(Boolean).length))
			seenCids.add(cid)
			seenPaths.add(path)
			directories.push({ cid, parentCid, name, path, depth })
			if (directories.length >= MAX_DIRECTORIES) break
		}
		const revision = Number(source.revision)
		const scannedAt = Number(source.scannedAt)
		return {
			schema: 1,
			revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
			scannedAt: Number.isFinite(scannedAt) && scannedAt >= 0 ? scannedAt : 0,
			roots: normalizeRoots(source.roots),
			directories,
		}
	}

	async function read() {
		if (!storage()?.get) return normalizeIndex(null)
		const values = await storage().get(storageKey)
		return normalizeIndex(values?.[storageKey])
	}

	async function write(value) {
		const index = normalizeIndex(value)
		if (!storage()?.set) throw new Error('扩展存储不可用')
		await storage().set({ [storageKey]: index })
		return index
	}

	function enqueueScan(work) {
		const result = scanChain.catch(() => {}).then(work)
		scanChain = result.catch(() => {})
		return result
	}

	function removeSubtree(byCid, rootCid) {
		const root = byCid.get(rootCid)
		const prefix = root?.path ? `${root.path}/` : ''
		const removed = new Set([rootCid])
		let changed = true
		while (changed) {
			changed = false
			for (const [cid, item] of byCid) {
				if (removed.has(cid)) continue
				const parentCid = normalizeCid(item.parentCid)
				if (removed.has(parentCid) || (prefix && item.path.startsWith(prefix))) {
					removed.add(cid)
					changed = true
				}
			}
		}
		for (const cid of removed) byCid.delete(cid)
	}

	function removeMissingChildren(byCid, parentCid, observedCids) {
		for (const [cid, item] of [...byCid]) {
			if (item.parentCid === parentCid && !observedCids.has(cid)) removeSubtree(byCid, cid)
		}
	}

	function rewriteSubtreePaths(byCid, rootCid, rootPath, rootDepth) {
		const pending = [{ cid: rootCid, path: rootPath, depth: rootDepth }]
		const visited = new Set([rootCid])
		while (pending.length > 0) {
			const parent = pending.shift()
			for (const [cid, item] of [...byCid]) {
				if (visited.has(cid) || item.parentCid !== parent.cid) continue
				const path = joinPath(parent.path, item.name)
				if (!path) continue
				const depth = Math.min(MAX_DEPTH, parent.depth + 1)
				byCid.set(cid, { ...item, path, depth })
				visited.add(cid)
				pending.push({ cid, path, depth })
			}
		}
	}

	async function syncBridge(index) {
		const sync = background.BridgeClient?.syncDirectoryRegistry
		if (typeof sync !== 'function') return { skipped: true, reason: 'bridge_unavailable' }
		try {
			const result = await sync(index)
			return {
				...(result || {}),
				ok: result?.disabled !== true && result?.permission !== false && result?.skipped !== true,
			}
		} catch (error) {
			console.warn('[DirectoryIndex] Bridge registry sync failed:', error?.message || error)
			return { ok: false, error: String(error?.message || error) }
		}
	}

	async function syncStored() {
		const index = await read()
		if (!index.directories.length && index.revision === 0) return { index, skipped: true, reason: 'empty' }
		return { index, bridge: await syncBridge(index) }
	}

	async function scan(details = {}) {
		return enqueueScan(async () => {
			const current = await read()
			const roots = normalizeRoots(details.roots ?? details.rootCids ?? ['0'])
			const maxDepth = clampDepth(details.maxDepth ?? details.depth, 1)
			const byCid = new Map(current.directories.map(item => [item.cid, item]))
			const queue = roots.map(cid => ({
				cid,
				parentCid: null,
				path: cid === '0' ? '' : (byCid.get(cid)?.path || ''),
				depth: 0,
			}))
			const visited = new Set()
			const startedAt = Date.now()
			let scanned = 0
			let requests = 0
			let reason = null
			const markBudget = candidate => {
				if (!reason && candidate) reason = candidate
				return Boolean(reason)
			}
			const stopBeforeRead = () => {
				if (reason) return true
				if (Date.now() - startedAt >= MAX_DURATION_MS) return markBudget('duration_limit')
				if (scanned >= MAX_DIRECTORIES) return markBudget('directory_limit')
				if (requests >= MAX_REQUESTS) return markBudget('request_limit')
				return false
			}
			const stopAfterRead = () => {
				if (reason) return true
				return Date.now() - startedAt >= MAX_DURATION_MS && markBudget('duration_limit')
			}
			while (queue.length > 0) {
				const currentFolder = queue.shift()
				if (!currentFolder || visited.has(currentFolder.cid)) continue
				if (stopBeforeRead()) break
				visited.add(currentFolder.cid)
				scanned += 1
				requests += 1
				const listing = await background.Folders.read(currentFolder.cid)
				stopAfterRead()
				const basePath = currentFolder.path || breadcrumbPath(listing?.path, currentFolder.cid)
				const items = Array.isArray(listing?.items) ? listing.items : []
				const children = []
				const observedCids = new Set()
				for (const item of items) {
					if (!background.Folders.isFolder(item)) continue
					const cid = normalizeCid(background.Folders.cidOf(item))
					const name = normalizeName(background.Folders.nameOf(item))
					if (!cid || cid === '0' || !name) continue
					const path = joinPath(basePath, name)
					if (!path) continue
					if (observedCids.has(cid)) continue
					observedCids.add(cid)
					children.push({
						cid,
						parentCid: currentFolder.cid,
						name,
						path,
						depth: Math.min(MAX_DEPTH, currentFolder.depth + 1),
					})
				}
				removeMissingChildren(byCid, currentFolder.cid, observedCids)
				for (const record of children) {
					const existing = byCid.get(record.cid)
					if (!existing && byCid.size >= MAX_DIRECTORIES) {
						markBudget('entry_limit')
						continue
					}
					const pathOwner = [...byCid.values()].find(item => item.path === record.path && item.cid !== record.cid)
					if (pathOwner) continue
					if (existing && existing.path !== record.path) {
						rewriteSubtreePaths(byCid, record.cid, record.path, record.depth)
					}
					byCid.set(record.cid, record)
					if (!reason && currentFolder.depth + 1 < maxDepth && !visited.has(record.cid)) {
						queue.push({ cid: record.cid, parentCid: currentFolder.cid, path: record.path, depth: record.depth })
					}
				}
				if (reason) break
			}
			const next = normalizeIndex({
				schema: 1,
				revision: Math.min(Number.MAX_SAFE_INTEGER, current.revision + 1),
				scannedAt: Date.now(),
				roots,
				directories: [...byCid.values()],
			})
			await write(next)
			return {
				index: next,
				bridge: await syncBridge(next),
				complete: !reason,
				truncated: Boolean(reason),
				reason,
				scanned,
				requests,
			}
		})
	}

	async function resolvePath(path) {
		const target = normalizePath(path) || ''
		if (!target) return '0'
		const index = await read()
		return index.directories.find(item => item.path === target)?.cid || null
	}

	async function resolveCid(cid) {
		const target = normalizeCid(cid)
		if (!target) return null
		if (target === '0') return '/'
		const index = await read()
		return index.directories.find(item => item.cid === target)?.path || null
	}

	background.DirectoryIndex = {
		MAX_DIRECTORIES,
		MAX_REQUESTS,
		MAX_DURATION_MS,
		MAX_DEPTH,
		storageKey,
		normalizeCid,
		normalizeIndex,
		read,
		write,
		scan,
		syncStored,
		resolvePath,
		resolveCid,
	}
})(globalThis)
