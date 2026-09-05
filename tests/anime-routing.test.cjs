const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = path.join(__dirname, '../src/chrome-extension')

function environment(saved = {}, disk = null) {
	const data = saved
	const tree = disk || new Map([['0', { name: 'Root', parent: '', items: [] }], ['10', { name: 'Anime', parent: '0', items: [] }]])
	if (!disk) tree.get('0').items.push({ cid: '10', n: 'Anime' })
	let serial = 100
	const calls = { move: [], remove: [], create: [], offline: [] }
	const faults = { remove: false, move: false, fallback: '', state: true, pageSize: 500 }
	function folder(parent, name, id = String(serial++)) {
		tree.set(id, { name, parent, items: [] })
		tree.get(parent).items.push({ cid: id, pid: parent, n: name })
		return id
	}
	function file(parent, name, fid = String(serial++)) {
		const value = { fid, n: name, sha: 'sha-' + fid, s: 600000000 }
		tree.get(parent).items.push(value)
		return value
	}
	const FilesApi = {
		operationSucceeded: r => [true, 1, '1'].includes(r?.state),
		async list(cid, offset = 0) {
			cid = String(cid)
			if (!tree.has(cid) || faults.fallback === cid) cid = '0'
			const node = tree.get(cid)
			const crumbs = []
			for (let id = cid; id; id = tree.get(id).parent) crumbs.unshift({ cid: id, name: tree.get(id).name })
			return { state: faults.state, path: crumbs, count: node.items.length, data: structuredClone(node.items.slice(offset, offset + faults.pageSize)) }
		},
		async createFolder(parent, name) { calls.create.push({ parent, name }); return { state: true, cid: folder(parent, name) } },
		async move(fid, cid) {
			calls.move.push(fid)
			if (faults.move) { faults.move = false; return { state: false } }
			for (const node of tree.values()) {
				const index = node.items.findIndex(item => item.fid === fid)
				if (index >= 0) { tree.get(cid).items.push(...node.items.splice(index, 1)); return { state: true } }
			}
			return { state: false }
		},
		async remove(cid) {
			calls.remove.push(cid)
			if (faults.remove) { faults.remove = false; return { state: false } }
			if (Array.isArray(cid)) {
				for (const node of tree.values()) node.items = node.items.filter(item => !cid.includes(item.fid))
				return { state: true }
			}
			assert.equal(tree.get(cid).items.length, 0, 'must never delete a non-empty folder')
			const parent = tree.get(cid).parent
			tree.get(parent).items = tree.get(parent).items.filter(item => item.cid !== cid)
			tree.delete(cid)
			return { state: true }
		},
	}
	const context = vm.createContext({
		console, URL, URLSearchParams, structuredClone, setTimeout,
		crypto: require('node:crypto').webcrypto,
		chrome: {
			storage: { local: {
				async get(keys) {
					await new Promise(resolve => setTimeout(resolve, 0))
					return structuredClone(keys == null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])))
				},
				async set(values) { Object.assign(data, structuredClone(values)) },
			} },
			runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } },
			alarms: { get: async () => true, create: async () => {} },
		},
	})
	const load = file => vm.runInContext(fs.readFileSync(path.join(source, file), 'utf8'), context, { filename: file })
	load('shared/config.js'); load('shared/download-intent.js'); load('shared/anime-series.js'); load('shared/file-rules.js')
	context.Push115.Background = { FilesApi, OfflineApi: {
		async addTask(url, cid) { calls.offline.push({ url, cid }); return { info_hash: context.Push115.DownloadIntent.extractBtih(url) } },
		async getTasks() { return context.remoteTasks || [] },
	} }
	for (const file of ['tasks/folders.js', 'tasks/anime-library.js', 'tasks/store.js', 'processors/cleanup.js', 'processors/generic.js', 'processors/anime.js', 'processors/jav.js', 'tasks/monitor.js', 'router.js']) load('background/' + file)
	// Explicitly run monitors in tests; queue's wakeup still follows the production contract.
	context.Push115.Background.TaskMonitor.processPending = async () => {}
	load('content/ui/submission-queue.js')
	return { context, p: context.Push115, bg: context.Push115.Background, data, tree, folder, file, calls, faults }
}

const series = { key: 'mikan:2087', title: 'Example Season 2', pageUrl: 'https://mikan.tangbai.cc/Home/Bangumi/2087' }
const magnet = n => 'magnet:?xt=urn:btih:' + String(n).padStart(40, '0')
const intent = (n, target) => ({ url: magnet(n), sourceSite: 'mikan', mediaType: 'anime', processorProfile: 'anime', title: `EP${n}`, savePathCid: target.cid, metadata: { series, animeTarget: target } })
const prepare = e => e.bg.AnimeLibrary.prepare({ series, mode: 'create', cid: '10', folderName: series.title, expectedCid: '' })

test('same Mikan ID survives title changes and URL parameters; different seasons never share identity', () => {
	const e = environment()
	assert.equal(e.p.AnimeSeries.fromPage(series.pageUrl + '?from=rss#group', 'Other fansub title').key, series.key)
	assert.notEqual(e.p.AnimeSeries.fromPage(series.pageUrl.replace('2087', '2088'), series.title).key, series.key)
	assert.equal(e.p.AnimeSeries.fromPage('https://mikan.tangbai.cc/Home/Search', series.title), null)
	assert.equal(e.p.AnimeSeries.fromPage('https://example.org/Home/Bangumi/2087', series.title), null)
})

test('first 8 episodes, worker restart, and a later single EP09 use one remembered CID', async () => {
	let e = environment()
	const target = await prepare(e)
	for (let n = 1; n <= 8; n++) {
		const root = e.folder(target.cid, 'release-' + n)
		e.file(root, `EP${n}.mkv`)
		const task = { ...intent(n, target), taskId: 'task' + n, createdAt: Date.now(), status: 'waiting' }
		await e.bg.Processors.anime.process({ task, targetCid: root, folderResolved: true, config: {}, appendLog: e.bg.TaskStore.appendLog })
		assert.equal(e.tree.has(root), false)
	}
	const disk = e.tree
	e = environment(e.data, disk)
	const saved = await e.bg.AnimeLibrary.get(series.key)
	const reused = await e.bg.AnimeLibrary.prepare({ series: { ...series, title: 'Changed title' }, mode: 'reuse', expectedCid: saved.cid })
	assert.equal(reused.cid, target.cid)
	const root = e.folder(target.cid, 'release-9', '900')
	e.file(root, 'EP9.mkv', '901')
	const task = { ...intent(9, target), taskId: 'task9', remoteId: '9'.padStart(40, '0'), createdAt: Date.now(), status: 'waiting' }
	e.context.remoteTasks = [{ info_hash: task.remoteId, name: 'release-9', file_id: root, status: 2 }]
	await e.bg.TaskMonitor.processTask(task)
	assert.equal(task.status, 'completed')
	assert.equal(e.tree.get(target.cid).items.filter(x => x.sha).length, 9)
	assert.equal(e.tree.has(root), false)
	assert.equal(e.calls.create.length, 0)
})

test('one complete collection is flattened with subtitles; unknown files remain and no media is renamed', async () => {
	const e = environment(); const target = await prepare(e)
	const root = e.folder(target.cid, 'Collection'); const nested = e.folder(root, 'Season')
	e.file(nested, '[Group] EP01.mkv'); e.file(nested, '[Group] EP01.ass'); e.file(root, 'booklet.zip')
	const task = { ...intent(1, target), taskId: 'collection' }
	const messages = await e.bg.Processors.anime.process({ task, targetCid: root, folderResolved: true, config: {}, appendLog: e.bg.TaskStore.appendLog })
	assert.equal(e.tree.has(nested), false)
	assert.equal(e.tree.get(root).items[0].n, 'booklet.zip')
	assert.deepEqual(e.tree.get(target.cid).items.filter(x => x.sha).map(x => x.n), ['[Group] EP01.mkv', '[Group] EP01.ass'])
	assert.match(messages.join(), /保留/)
})

test('move succeeds but empty-folder recycling fails: resume saved IDs after restart even without offline record', async () => {
	let e = environment(); const target = await prepare(e)
	const root = e.folder(target.cid, 'EP01'); const video = e.file(root, 'EP01.mkv')
	const task = { ...intent(1, target), taskId: 'retry', createdAt: Date.now(), status: 'waiting' }
	e.faults.remove = true
	await assert.rejects(e.bg.Processors.anime.process({ task, targetCid: root, folderResolved: true, config: {}, appendLog: e.bg.TaskStore.appendLog }), /回收空任务目录失败/)
	assert.equal(e.data.push115_tasks[0].animeTransfer.files[0].fid, video.fid)
	e = environment(e.data, e.tree)
	const resumed = (await e.bg.TaskStore.read())[0]
	await e.bg.TaskMonitor.processTask(resumed)
	assert.equal(resumed.status, 'completed'); assert.equal(e.calls.move.length, 0); assert.equal(e.tree.has(root), false)
})

test('same-name collision and failed move keep source and do not report completion', async () => {
	const e = environment(); const target = await prepare(e)
	const root = e.folder(target.cid, 'EP01'); e.file(root, 'EP01.mkv'); e.file(target.cid, 'EP01.mkv')
	const task = { ...intent(1, target), taskId: 'collision' }
	await assert.rejects(e.bg.Processors.anime.process({ task, targetCid: root, folderResolved: true, config: {}, appendLog: e.bg.TaskStore.appendLog }), /同名冲突/)
	assert.equal(e.calls.move.length, 0); assert.equal(e.calls.remove.length, 0); assert.equal(task.animeTransfer.finished, false)
})

test('deleted bound directory / 115 root fallback never creates replacement or submits a download', async () => {
	const e = environment(); const target = await prepare(e)
	e.faults.fallback = target.cid
	await assert.rejects(e.bg.Router.submitIntent(intent(1, target)), /返回了其他目录/)
	assert.equal(e.calls.offline.length, 0); assert.equal(e.calls.create.length, 1)
})

test('concurrent same-series prepare creates one folder and requires stale dialogs to refresh', async () => {
	const e = environment()
	const results = await Promise.allSettled([prepare(e), prepare(e)])
	assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
	assert.equal(e.calls.create.length, 1)
})

test('concurrent repeated hash is skipped; clearing logs keeps mapping and receipt; user may force redownload', async () => {
	const e = environment(); const target = await prepare(e)
	const results = await Promise.all([e.bg.Router.submitIntent(intent(1, target)), e.bg.Router.submitIntent(intent(1, target))])
	assert.equal(results.filter(x => x.duplicate).length, 1); assert.equal(e.calls.offline.length, 1)
	const task = (await e.bg.TaskStore.read())[0]; task.status = 'completed'; await e.bg.TaskStore.persist(task)
	await e.bg.TaskStore.clearLogs()
	assert.equal((await e.bg.AnimeLibrary.get(series.key)).cid, target.cid)
	assert.equal((await e.bg.Router.submitIntent(intent(1, target))).duplicate, true)
	const retry = intent(1, target); retry.metadata.skipSubmitted = false
	await e.bg.Router.submitIntent(retry); assert.equal(e.calls.offline.length, 2)
})

test('concurrent persistence retains all active tasks, including more than the old 50-task limit', async () => {
	const e = environment()
	await Promise.all(Array.from({ length: 65 }, (_, i) => e.bg.TaskStore.persist({ taskId: String(i), status: 'waiting' })))
	assert.equal((await e.bg.TaskStore.read()).length, 65)
})

test('pagination includes all files; false state and unresolved source cannot trigger broad cleanup', async () => {
	const e = environment(); const target = await prepare(e)
	e.faults.pageSize = 2
	for (let n = 1; n <= 7; n++) e.file(target.cid, `EP${n}.mkv`)
	assert.equal((await e.bg.Folders.read(target.cid)).items.length, 7)
	const task = { ...intent(8, target), taskId: 'unresolved' }
	await assert.rejects(e.bg.Processors.anime.process({ task, targetCid: target.cid, folderResolved: false, config: { push115_auto_delete_small: true }, appendLog: e.bg.TaskStore.appendLog }), /独立目录/)
	e.faults.state = false
	await assert.rejects(e.bg.Folders.read(target.cid), /无法读取/)
	assert.equal(e.calls.remove.length, 0)
})

test('manual/generic source choosing anime still gets monitoring; profile override disables grouping', async () => {
	const e = environment()
	const value = { url: magnet(1), mediaType: 'generic', processorProfile: 'anime', metadata: { batchId: 'manual-batch' }, savePathCid: '10' }
	assert.equal((await e.bg.Router.submitIntent(value)).task.status, 'waiting')
	const target = await prepare(e)
	const overridden = intent(2, target); overridden.processorProfile = 'generic'
	assert.equal((await e.bg.Router.submitIntent(overridden)).task.status, 'recorded')
})
