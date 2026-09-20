const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function environment(listing) {
	const calls = []
	const context = vm.createContext({
		console,
		Promise,
		setTimeout,
		clearTimeout,
		Push115: {
			Background: {
				FilesApi: {
					async list(cid, offset) {
						calls.push([String(cid), offset])
						return structuredClone(typeof listing === 'function' ? listing(cid, offset) : listing)
					},
					operationSucceeded(result) { return result?.state === 1 },
				},
			},
		},
		structuredClone,
	})
	vm.runInContext(fs.readFileSync(path.join(extension, 'background/tasks/folders.js'), 'utf8'), context, {
		filename: 'background/tasks/folders.js',
	})
	return { api: context.Push115.Background.Folders, calls }
}

test('folder reads accept current-folder-first breadcrumbs and file id aliases', async () => {
	const e = environment({
		state: 1,
		path: [{ id: '42', name: '媒体' }, { cid: '0', n: '根目录' }],
		data: [{ id: 'file-1', name: 'movie.mkv', sha: 'present' }, { cid: '99', n: 'JAV' }],
	})
	const result = await e.api.read('42')
	assert.deepEqual(JSON.parse(JSON.stringify(result.path)), [
		{ cid: '0', n: '根目录' },
		{ id: '42', name: '媒体' },
	])
	assert.equal(result.items.length, 2)
	assert.deepEqual(e.calls, [['42', 0]])
})

test('folder reads tolerate a missing total count without scanning past a short page', async () => {
	const e = environment({
		state: 1,
		path: [{ cid: '0', n: '根目录' }, { cid: '7', n: '媒体' }],
		data: [{ fid: 'file-1', n: 'movie.mkv', sha: 'present' }],
	})
	const result = await e.api.read('7')
	assert.equal(result.items.length, 1)
	assert.deepEqual(e.calls, [['7', 0]])
})

test('root reads remain safe when the API omits a breadcrumb', async () => {
	const e = environment({ state: 1, data: [] })
	const result = await e.api.read('0')
	assert.deepEqual(JSON.parse(JSON.stringify(result.path)), [{ cid: '0', n: '根目录' }])
})
