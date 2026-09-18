const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function environment() {
	const data = {}
	const calls = []
	const listings = {
		'0': {
			path: [{ cid: '0', n: '根目录' }],
			items: [
				{ cid: '123', n: '媒体' },
				{ cid: '456', n: '备份' },
				{ fid: 'file-1', n: 'movie.mkv', sha: 'file' },
			],
		},
		'123': {
			path: [{ cid: '0', n: '根目录' }, { cid: '123', n: '媒体' }],
			items: [{ cid: '789', n: 'JAV' }],
		},
		'789': {
			path: [{ cid: '0', n: '根目录' }, { cid: '123', n: '媒体' }, { cid: '789', n: 'JAV' }],
			items: [{ cid: '999', n: '有码' }],
		},
	}
	const context = vm.createContext({
		console,
		Date,
		Promise,
		structuredClone,
		setTimeout,
		clearTimeout,
		chrome: {
			storage: {
				local: {
					async get(key) { return { [key]: structuredClone(data[key]) } },
					async set(values) { Object.assign(data, structuredClone(values)) },
				},
			},
		},
		Push115: {
			Config: { STORAGE_KEYS: { DIRECTORY_INDEX: 'push115_directory_index' } },
			Background: {
			Folders: {
				async read(cid) { calls.push(String(cid)); return structuredClone(listings[String(cid)]) },
				isFolder(item) { return Boolean(item && !item.sha && item.cid) },
				cidOf(item) { return item?.cid || item?.fid || '' },
				nameOf(item) { return item?.n || item?.name || '' },
				pathCidOf(item) { return item?.cid || item?.id || item?.fid || '' },
			},
			BridgeClient: {
				async syncDirectoryRegistry(index) { return { revision: index.revision } },
			},
		},
	},
	})
	vm.runInContext(fs.readFileSync(path.join(extension, 'background/directory-index.js'), 'utf8'), context, {
		filename: 'background/directory-index.js',
	})
	return { api: context.Push115.Background.DirectoryIndex, data, calls }
}

test('directory scan builds a shallow index from folder listings and syncs it', async () => {
	const e = environment()
	const result = await e.api.scan({ roots: ['0'], maxDepth: 1 })
	assert.equal(e.calls.join(','), '0')
	assert.equal(result.index.revision, 1)
	assert.deepEqual(JSON.parse(JSON.stringify(result.index.directories)), [
		{ cid: '123', parentCid: '0', name: '媒体', path: '/媒体', depth: 1 },
		{ cid: '456', parentCid: '0', name: '备份', path: '/备份', depth: 1 },
	])
	assert.equal(result.bridge.ok, true)
	assert.deepEqual(JSON.parse(JSON.stringify(e.data.push115_directory_index)), JSON.parse(JSON.stringify(result.index)))
})

test('selected roots can be recursively scanned without traversing unrelated folders', async () => {
	const e = environment()
	await e.api.scan({ roots: ['0'], maxDepth: 1 })
	e.calls.length = 0
	const result = await e.api.scan({ roots: ['123'], maxDepth: 3 })
	assert.equal(e.calls.join(','), '123,789,999')
	assert.deepEqual(JSON.parse(JSON.stringify(result.index.directories.map(item => item.path))), ['/媒体', '/备份', '/媒体/JAV', '/媒体/JAV/有码'])
	assert.equal(await e.api.resolvePath('/媒体/JAV'), '789')
	assert.equal(await e.api.resolveCid('789'), '/媒体/JAV')
	assert.equal(await e.api.resolveCid('0'), '/')
	e.calls.length = 0
	const shallow = await e.api.scan({ roots: ['123'], maxDepth: 1 })
	assert.equal(e.calls.join(','), '123')
	assert.deepEqual(JSON.parse(JSON.stringify(shallow.index.directories.map(item => item.path))), ['/媒体', '/备份', '/媒体/JAV'])
})

test('index normalization removes unsafe, duplicate, and oversized records', () => {
	const e = environment()
	const index = e.api.normalizeIndex({
		revision: -1,
		roots: ['bad', '0', '0'],
		directories: [
			{ cid: '1', name: 'safe', path: '/safe', depth: 1 },
			{ cid: '1', name: 'duplicate', path: '/duplicate', depth: 1 },
			{ cid: '2', name: '../unsafe', path: '/../unsafe', depth: 1 },
			{ cid: '3', name: 'slash/name', path: '/slash/name', depth: 1 },
		],
	})
	assert.equal(index.revision, 0)
	assert.deepEqual(JSON.parse(JSON.stringify(index.roots)), ['0'])
	assert.deepEqual(JSON.parse(JSON.stringify(index.directories)), [{ cid: '1', parentCid: '0', name: 'safe', path: '/safe', depth: 1 }])
})
