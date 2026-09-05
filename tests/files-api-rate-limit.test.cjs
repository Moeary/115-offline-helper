const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = path.join(__dirname, '../src/chrome-extension/background/api/files.js')
const offlineSource = path.join(__dirname, '../src/chrome-extension/background/api/offline.js')

test('115 file mutations are serialized and spaced', { timeout: 5000 }, async () => {
	const starts = []
	let active = 0
	let maximumActive = 0
	const context = vm.createContext({
		console,
		Date,
		Promise,
		URLSearchParams,
		setTimeout,
		Push115: {
			Background: {
				Client: {
					async data() {
						starts.push(Date.now())
						active += 1
						maximumActive = Math.max(maximumActive, active)
						await new Promise(resolve => setTimeout(resolve, 8))
						active -= 1
						return { state: true }
					},
				},
			},
		},
	})
	vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source })
	const api = context.Push115.Background.FilesApi
	await Promise.all([
		api.move('1', '2'),
		api.rename('1', 'restored.mkv'),
		api.remove('1'),
		api.createFolder('2', '__push115_stage_test'),
	])

	assert.equal(maximumActive, 1)
	assert.equal(starts.length, 4)
	for (let index = 1; index < starts.length; index += 1) {
		assert.ok(starts[index] - starts[index - 1] >= 450, `mutation ${index} was not spaced`)
	}
	assert.equal(api.mutationPolicy.concurrency, 1)
	assert.equal(api.mutationPolicy.minIntervalMs, 500)

	vm.runInContext(fs.readFileSync(offlineSource, 'utf8'), context, { filename: offlineSource })
	const beforeSubmissions = starts.length
	await Promise.all([
		context.Push115.Background.OfflineApi.addTask('magnet:?xt=urn:btih:one', '2'),
		context.Push115.Background.OfflineApi.addTask('magnet:?xt=urn:btih:two', '2'),
	])
	assert.equal(starts.length, beforeSubmissions + 6)
	assert.ok(starts[beforeSubmissions + 3] - starts[beforeSubmissions + 2] >= 450, 'offline handshakes were not spaced')
	assert.equal(context.Push115.Background.OfflineApi.submissionPolicy.concurrency, 1)
	assert.equal(context.Push115.Background.OfflineApi.submissionPolicy.minIntervalMs, 500)
})
