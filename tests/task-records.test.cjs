const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function environment() {
	const data = {}
	let runtimeMessageListener = null
	const context = vm.createContext({
		console,
		URL,
		URLSearchParams,
		structuredClone,
		crypto: require('node:crypto').webcrypto,
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return structuredClone(data)
						const requested = Array.isArray(keys) ? keys : [keys]
						return Object.fromEntries(requested.map(key => [key, structuredClone(data[key])]))
					},
					async set(values) { Object.assign(data, structuredClone(values)) },
				},
			},
			runtime: {
				sendMessage: async () => ({}),
				onMessage: { addListener(listener) { runtimeMessageListener = listener } },
			},
			alarms: { get: async () => true, create: async () => {} },
		},
	})
	const load = relative => vm.runInContext(
		fs.readFileSync(path.join(extension, relative), 'utf8'),
		context,
		{ filename: relative },
	)
	load('shared/config.js')
	load('shared/download-intent.js')
	context.Push115.Background = {
		TaskMonitor: { ensureAlarm: async () => {}, processPending: async () => {} },
	}
	load('background/tasks/store.js')
	load('background/router.js')
	context.Push115.Background.Router.listen()
	const invoke = request => new Promise((resolve, reject) => {
		if (!runtimeMessageListener) return reject(new Error('runtime message listener is not registered'))
		runtimeMessageListener(request, {}, resolve)
	})
	return { context, data, invoke }
}

const ed2k = name => `ed2k://|file|${name}|123|ABCDEF0123456789ABCDEF0123456789|/`

test('South Plus records persist metadata without submitting a 115 task and deduplicate links', async () => {
	const e = environment()
	const first = {
		url: ed2k('MNGS-060 restored.mp4'),
		sourceSite: 'southplus',
		mediaType: 'jav',
		processorProfile: 'jav',
		title: 'MNGS-060 restored.mp4',
		code: 'MNGS-060',
		metadata: { pageUrl: 'https://www.south-plus.net/read.php?tid-1', pageCode: 'MNGS-060' },
		savePathCid: '42',
	}
	const response = await e.invoke({ action: 'RECORD_INTENTS', details: { intents: [first, first] } })
	assert.equal(response.success, true)
	assert.equal(response.recorded, 1)
	assert.equal(response.duplicate, 1)
	assert.equal(e.data.push115_tasks.length, 1)
	assert.equal(e.data.push115_tasks[0].status, 'recorded')
	assert.equal(e.data.push115_tasks[0].code, 'MNGS-060')
	assert.equal(e.data.push115_tasks[0].metadata.pageCode, 'MNGS-060')
	assert.equal(e.data.push115_tasks[0].savePathCid, '42')
})

test('recording an already submitted link does not create a second local history item', async () => {
	const e = environment()
	const url = ed2k('MIDA-190 4K60fps.mp4')
	await e.invoke({
		action: 'QUEUE_TASK',
		details: {
		intent: { url, sourceSite: 'southplus', mediaType: 'jav', processorProfile: 'jav', code: 'MIDA-190' },
		monitor: false,
		remoteId: '',
		name: 'MIDA-190 4K60fps.mp4',
		},
	})
	const response = await e.invoke({
		action: 'RECORD_INTENTS',
		details: { intents: [{ url, sourceSite: 'southplus', code: 'MIDA-190', processorProfile: 'jav' }] },
	})
	assert.equal(response.success, true)
	assert.equal(response.recorded, 0)
	assert.equal(response.duplicate, 1)
	assert.equal(e.data.push115_tasks.length, 1)
})
