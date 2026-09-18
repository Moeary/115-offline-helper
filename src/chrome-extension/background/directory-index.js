;(function (global) {
	'use strict'

	const push115 = global.Push115 = global.Push115 || {}
	const background = push115.Background = push115.Background || {}
	const config = push115.Config || {}
	const storageKey = config.STORAGE_KEYS?.DIRECTORY_INDEX || 'push115_directory_index'
	const CID_PATTERN = /^\d{1,64}$/
	const MAX_ROOTS = 32
	const MAX_DIRECTORIES = 4000
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
			// A successful scan is authoritative for the requested subtree. Drop
			// stale descendants before merging the fresh listing, while retaining
			// the selected non-root record itself as the parent of newly discovered
			// children.
			for (const root of roots) {
				if (root === '0') {
					byCid.clear()
					break
				}
				const rootRecord = byCid.get(root)
				if (!rootRecord) continue
				const prefix = `${rootRecord.path}/`
				for (const [cid, item] of byCid) {
					if (cid !== root && (item.path === rootRecord.path || item.path.startsWith(prefix))) byCid.delete(cid)
				}
			}
			const queue = roots.map(cid => ({
				cid,
				parentCid: null,
				path: cid === '0' ? '' : (byCid.get(cid)?.path || ''),
				depth: 0,
			}))
			const visited = new Set()
			while (queue.length > 0) {
				const currentFolder = queue.shift()
				if (!currentFolder || visited.has(currentFolder.cid)) continue
				visited.add(currentFolder.cid)
				const listing = await background.Folders.read(currentFolder.cid)
				const basePath = currentFolder.path || breadcrumbPath(listing?.path, currentFolder.cid)
				const items = Array.isArray(listing?.items) ? listing.items : []
				for (const item of items) {
					if (!background.Folders.isFolder(item)) continue
					const cid = normalizeCid(background.Folders.cidOf(item))
					const name = normalizeName(background.Folders.nameOf(item))
					if (!cid || cid === '0' || !name) continue
					const path = joinPath(basePath, name)
					if (!path) continue
					const record = {
						cid,
						parentCid: currentFolder.cid,
						name,
						path,
						depth: Math.min(MAX_DEPTH, currentFolder.depth + 1),
					}
					if (!byCid.has(cid) || byCid.get(cid)?.parentCid === currentFolder.cid) byCid.set(cid, record)
					if (currentFolder.depth + 1 < maxDepth && !visited.has(cid)) {
						queue.push({ cid, parentCid: currentFolder.cid, path, depth: currentFolder.depth + 1 })
					}
				}
			}
			const next = normalizeIndex({
				schema: 1,
				revision: Math.min(Number.MAX_SAFE_INTEGER, current.revision + 1),
				scannedAt: Date.now(),
				roots,
				directories: [...byCid.values()],
			})
			await write(next)
			return { index: next, bridge: await syncBridge(next) }
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
