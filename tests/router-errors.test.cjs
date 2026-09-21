const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

function load(context, relative) {
	return vm.runInContext(
		fs.readFileSync(path.join(extension, relative), 'utf8'),
		context,
		{ filename: relative },
	)
}

function testConsole() {
	const logs = { error: [], warn: [], info: [], log: [] }
	const console = Object.fromEntries(Object.keys(logs).map(level => [
		level,
		(...args) => logs[level].push(args),
	]))
	return { console, logs }
}

function flushTurn() {
	return new Promise(resolve => setImmediate(resolve))
}

async function assertNoUnhandledRejection(action) {
	const unhandled = []
	const onUnhandled = reason => unhandled.push(reason)
	process.on('unhandledRejection', onUnhandled)
	try {
		await action()
		await flushTurn()
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
	assert.equal(unhandled.length, 0, unhandled.map(error => error?.message || String(error)).join('; '))
}

function offlineEnvironment(finalResponse) {
	let clock = 0
	const clientCalls = []
	const responses = [
		{ data: { user_id: 'uid-1' } },
		{ sign: 'sign-1', time: 'time-1' },
		finalResponse,
	]
	class TestDate extends Date {
		static now() { return clock }
	}
	const context = vm.createContext({
		console,
		Date: TestDate,
		Promise,
		URLSearchParams,
		setTimeout(callback, delay) {
			clock += Number(delay) || 0
			callback()
			return 1
		},
		Push115: {
			Background: {
				Client: {
					async data(details) {
						clientCalls.push(details)
						return responses.shift()
					},
				},
			},
		},
	})
	load(context, 'background/api/offline.js')
	return { context, clientCalls }
}

async function addTaskWithResponse(finalResponse) {
	const environment = offlineEnvironment(finalResponse)
	try {
		const result = await environment.context.Push115.Background.OfflineApi.addTask(MAGNET, '42')
		return { result, clientCalls: environment.clientCalls }
	} catch (error) {
		return { error, clientCalls: environment.clientCalls }
	}
}

test('OfflineApi marks remote duplicate-task rejections while preserving the remote error contract', async () => {
	for (const message of ['任务已存在', '重复的链接地址']) {
		const result = await addTaskWithResponse({ state: false, error_msg: message })
		assert.equal(result.clientCalls.length, 3)
		assert.equal(result.error?.message, message)
		assert.equal(result.error?.code, 'REMOTE_REJECTED')
		assert.equal(result.error?.remoteRejected, true)
		assert.equal(result.error?.duplicate, true)
	}
})

test('OfflineApi does not classify an unrelated remote rejection as a duplicate', async () => {
	const result = await addTaskWithResponse({ state: false, error_msg: '链接被 115 拒绝' })
	assert.equal(result.error?.code, 'REMOTE_REJECTED')
	assert.equal(result.error?.remoteRejected, true)
	assert.notEqual(result.error?.duplicate, true)
})

function routerEnvironment({ addTask, prepare, notificationCreate } = {}) {
	const { console, logs } = testConsole()
	const tasks = []
	const queueCalls = []
	const notificationCalls = []
	const runtimeGetURLCalls = []
	let runtimeMessageListener = null
	const context = vm.createContext({
		console,
		Date,
		Promise,
		URL,
		URLSearchParams,
		structuredClone,
		setTimeout,
		clearTimeout,
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return {}
						const requested = Array.isArray(keys) ? keys : [keys]
						return Object.fromEntries(requested.map(key => [key, undefined]))
					},
					async set() {},
				},
			},
			runtime: {
				getURL(value) {
					runtimeGetURLCalls.push(value)
					return `chrome-extension://router-errors/${value}`
				},
				onMessage: {
					addListener(listener) { runtimeMessageListener = listener },
				},
			},
			notifications: {
				create(...args) {
					notificationCalls.push(args)
					return notificationCreate ? notificationCreate(...args) : Promise.resolve()
				},
			},
		},
		Push115: {
			Background: {
				OfflineApi: {
					addTask: addTask || (async () => ({ info_hash: 'remote-1' })),
					isDuplicateTaskError(error) {
						return /任务已存在|重复的链接|duplicate task|already exists/i.test(String(error?.message || error || ''))
					},
				},
				TaskStore: {
					async read() { return tasks },
					async queue(details) {
						queueCalls.push(details)
						const task = { taskId: `local-${queueCalls.length}`, status: 'waiting', ...details }
						tasks.push(task)
						return task
					},
					async record() { return {} },
				},
				AnimeLibrary: {
					async prepare(details) {
						return prepare ? prepare(details) : { cid: 'anime-1' }
					},
					async validateTarget() { return { submissions: {} } },
					async recordSubmission() {},
				},
			},
		},
	})
	load(context, 'shared/config.js')
	load(context, 'shared/download-intent.js')
	load(context, 'background/router.js')
	context.Push115.Background.Router.listen()
	const invoke = request => new Promise((resolve, reject) => {
		if (!runtimeMessageListener) return reject(new Error('runtime message listener is not registered'))
		try {
			runtimeMessageListener(request, {}, resolve)
		} catch (error) {
			reject(error)
		}
	})
	return {
		context,
		router: context.Push115.Background.Router,
		invoke,
		listener: runtimeMessageListener,
		tasks,
		queueCalls,
		notificationCalls,
		runtimeGetURLCalls,
		logs,
	}
}

function duplicateError(message, duplicate = false) {
	const error = new Error(message)
	if (duplicate) error.duplicate = true
	return error
}

const baseIntent = {
	url: MAGNET,
	sourceSite: 'generic',
	mediaType: 'generic',
	processorProfile: 'generic',
	savePathCid: '42',
}

test('Router.submitIntent returns a duplicate result and never queues a local task', async () => {
	for (const error of [
		duplicateError('115 拒绝提交，但已标记为重复', true),
		duplicateError('重复的链接地址'),
	]) {
		const environment = routerEnvironment({ addTask: async () => { throw error } })
		const result = await environment.router.submitIntent(baseIntent)
		assert.equal(result.duplicate, true)
		assert.equal(result.message, error.message)
		assert.equal(environment.queueCalls.length, 0)
		assert.equal(environment.tasks.length, 0)
	}
})

test('Router.listen returns duplicate submissions as successful results without error-level logging', async () => {
	const message = '任务已存在，请勿重复提交'
	const environment = routerEnvironment({
		addTask: async () => { throw duplicateError(message, true) },
	})
	const response = await environment.invoke({ action: 'SUBMIT_INTENT', details: { intent: baseIntent } })
	// Duplicate is a normal submission result for the content queue, not an error response.
	assert.equal(response.success, true)
	assert.equal(response.duplicate, true)
	assert.equal(response.message, message)
	assert.equal(environment.logs.error.length, 0)
	assert.equal(environment.queueCalls.length, 0)
})

test('Router.listen keeps stale anime-directory prompts visible with non-error logging', async () => {
	const message = '本番目录已在其他窗口修改，请重新打开确认窗口'
	const environment = routerEnvironment({
		prepare: async () => { throw new Error(message) },
	})
	const response = await environment.invoke({
		action: 'PREPARE_ANIME_SERIES',
		details: { mode: 'reuse', key: 'mikan:2087' },
	})
	assert.equal(response.success, false)
	assert.equal(response.error || response.message, message)
	assert.equal(environment.logs.error.length, 0)
	assert.ok(environment.logs.warn.length + environment.logs.info.length + environment.logs.log.length > 0)
})

test('Router notification failures are settled and use the runtime-resolved icon URL', async () => {
	for (const mode of ['reject', 'throw']) {
		const environment = routerEnvironment({
			notificationCreate() {
				if (mode === 'throw') throw new Error('notification sync failure')
				return Promise.reject(new Error('notification async failure'))
			},
		})
		await assertNoUnhandledRejection(async () => {
			assert.equal(environment.listener({
				action: 'NOTIFY',
				details: { title: 'Test', message: mode },
			}, {}, () => {}), undefined)
			await flushTurn()
		})
		assert.equal(environment.notificationCalls.length, 1)
		assert.equal(environment.notificationCalls[0][0].iconUrl, 'chrome-extension://router-errors/icons/icon48.png')
		assert.deepEqual(environment.runtimeGetURLCalls, ['icons/icon48.png'])
		assert.equal(environment.logs.error.length, 0)
	}
})

function monitorEnvironment(mode) {
	const { console, logs } = testConsole()
	const notificationCalls = []
	const runtimeGetURLCalls = []
	const storage = { push115_auto_delete_small: true, push115_auto_organize: false }
	const task = {
		taskId: 'monitor-notification',
		status: 'waiting',
		processorProfile: 'generic',
		mediaType: 'generic',
		remoteId: 'remote-notification',
		savePathCid: 'save-cid',
		createdAt: Date.now(),
		metadata: {},
	}
	const context = vm.createContext({
		console,
		Date,
		Promise,
		URL,
		URLSearchParams,
		structuredClone,
		setTimeout,
		clearTimeout,
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return structuredClone(storage)
						const requested = Array.isArray(keys) ? keys : [keys]
						return Object.fromEntries(requested.map(key => [key, storage[key]]))
					},
					async set(values) { Object.assign(storage, values) },
				},
			},
			runtime: {
				getURL(value) {
					runtimeGetURLCalls.push(value)
					return `chrome-extension://monitor-errors/${value}`
				},
			},
			alarms: { get: async () => true, create: async () => {} },
			notifications: {
				create(...args) {
					notificationCalls.push(args)
					if (mode === 'throw') throw new Error('notification sync failure')
					return Promise.reject(new Error('notification async failure'))
				},
			},
		},
		Push115: {},
	})
	load(context, 'shared/config.js')
	load(context, 'shared/download-intent.js')
	const storedTasks = [task]
	context.Push115.AnimeSeries = { needsFlatten: () => false }
	context.Push115.Background = {
		OfflineApi: {
			async getTasks() {
				return [{ info_hash: 'remote-notification', name: 'Finished', file_id: 'folder-1', status: 2 }]
			},
		},
		FilesApi: { list: async () => ({ data: [] }) },
		Folders: {
			async read() { return { items: [] } },
			isFolder: item => Boolean(item?.cid),
			cidOf: item => String(item?.cid || ''),
			nameOf: item => String(item?.n || item?.name || ''),
		},
		Processors: {
			Helpers: {
				isFolder: item => Boolean(item?.cid),
				getItemName: item => String(item?.n || item?.name || ''),
			},
			generic: { async process() { return [] } },
			anime: { async process() { return [] } },
			jav: { async process() { return [] } },
		},
		TaskStore: {
			async read() { return storedTasks },
			async persist() {},
			taskIsActive: value => ['waiting', 'processing'].includes(value?.status),
			isCancelled: () => false,
			appendLog() {},
		},
	}
	load(context, 'background/tasks/monitor.js')
	return {
		monitor: context.Push115.Background.TaskMonitor,
		task,
		notificationCalls,
		runtimeGetURLCalls,
		logs,
	}
}

test('TaskMonitor notification failures are settled and use the runtime-resolved icon URL', async () => {
	for (const mode of ['reject', 'throw']) {
		const environment = monitorEnvironment(mode)
		await assertNoUnhandledRejection(async () => {
			await environment.monitor.processTask(environment.task)
			await flushTurn()
		})
		assert.equal(environment.task.status, 'completed')
		assert.equal(environment.notificationCalls.length, 1)
		assert.equal(environment.notificationCalls[0][1].iconUrl, 'chrome-extension://monitor-errors/icons/icon48.png')
		assert.deepEqual(environment.runtimeGetURLCalls, ['icons/icon48.png'])
		assert.equal(environment.logs.error.length, 0)
	}
})
