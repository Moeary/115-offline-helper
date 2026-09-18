const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function response(body, status = 200) {
	return {
		status,
		ok: status >= 200 && status < 300,
		redirected: false,
		text: async () => JSON.stringify(body),
	}
}

function load(context, relative) {
	const filename = path.join(extension, relative)
	vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename })
}

function offlineContext(finalResponse) {
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
	const environment = offlineContext(finalResponse)
	try {
		const result = await environment.context.Push115.Background.OfflineApi.addTask(
			'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef',
			'42',
		)
		return { result, clientCalls: environment.clientCalls }
	} catch (error) {
		return { error, clientCalls: environment.clientCalls }
	}
}

test('OfflineApi marks only an explicit state false as a remote rejection', async () => {
	const result = await addTaskWithResponse({ state: false, error_msg: '链接被 115 拒绝' })
	assert.equal(result.clientCalls.length, 3)
	assert.equal(result.error?.message, '链接被 115 拒绝')
	assert.equal(result.error?.code, 'REMOTE_REJECTED')
	assert.equal(result.error?.remoteRejected, true)
})

test('OfflineApi keeps unknown or non-boolean falsey states conservative', async () => {
	for (const finalResponse of [
		{ state: 0, error_msg: '状态未知' },
		{ state: null },
		{},
	]) {
		const result = await addTaskWithResponse(finalResponse)
		assert.equal(result.clientCalls.length, 3)
		assert.equal(result.error?.name, 'Error')
		assert.notEqual(result.error.code, 'REMOTE_REJECTED')
		assert.notEqual(result.error.remoteRejected, true)
	}
})

function bridgeEnvironment(finalResponse) {
	const data = {
		push115_bridge_enabled: true,
		push115_bridge_token: 'secret-token',
	}
	const events = []
	const tasks = []
	const clientResponses = [
		{ data: { user_id: 'uid-1' } },
		{ sign: 'sign-1', time: 'time-1' },
		finalResponse,
	]
	const clientCalls = []
	const context = vm.createContext({
		console,
		Date,
		Promise,
		URL,
		URLSearchParams,
		structuredClone,
		setTimeout,
		clearTimeout,
		AbortController,
		crypto: require('node:crypto').webcrypto,
		fetch: async (url, request) => {
			if (url.endsWith('/claim')) {
				return response({
					schema: 1,
					job: {
						jobId: 'job-real-offline',
						leaseId: 'lease-real-offline',
						intent: {
							url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef',
							sourceSite: 'javbus',
							mediaType: 'jav',
							processorProfile: 'jav',
							code: 'ABC-123',
						},
					},
				})
			}
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			throw new Error(`unexpected bridge URL ${url}`)
		},
		chrome: {
			storage: {
				local: {
					async get(keys) {
						const requested = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {})
						return Object.fromEntries(requested.map(key => [key, structuredClone(data[key])]))
					},
					async set(values) { Object.assign(data, structuredClone(values)) },
				},
			},
			runtime: { id: 'offline-api-test' },
			permissions: { contains: async () => true },
			alarms: { get: async () => null, create: async () => {}, clear: async () => true },
		},
		Push115: {},
	})
	load(context, 'shared/config.js')
	const background = context.Push115.Background = {
		Client: {
			async data(details) {
				clientCalls.push(details)
				return clientResponses.shift()
			},
		},
		TaskStore: {
			async read() { return structuredClone(tasks) },
			async persist(task) {
				const index = tasks.findIndex(item => item.taskId === task.taskId)
				if (index >= 0) tasks[index] = structuredClone(task)
				else tasks.unshift(structuredClone(task))
			},
			appendLog(task, message) { task.message = message },
		},
		TaskMonitor: { ensureAlarm: async () => {} },
	}
	load(context, 'background/api/offline.js')
	background.Router = {
		async submitIntent(intent) {
			const result = await background.OfflineApi.addTask(intent.url, intent.savePathCid)
			const task = {
				taskId: 'task-real-offline',
				remoteId: 'remote-real-offline',
				status: 'waiting',
				metadata: { ...intent.metadata },
			}
			tasks.push(task)
			return { result, task }
		},
	}
	load(context, 'background/bridge-client.js')
	return { context, data, events, tasks, clientCalls }
}

test('Bridge marks a real OfflineApi state false response as failed', async () => {
	const environment = bridgeEnvironment({ state: false, error_msg: '115 拒绝此任务' })
	const result = await environment.context.Push115.Background.BridgeClient.processPending()
	assert.equal(result.jobId, 'job-real-offline')
	assert.equal(environment.clientCalls.length, 3)
	assert.equal(environment.events.length, 1)
	assert.equal(environment.events[0].state, 'failed')
	assert.equal(environment.events[0].errorCode, 'REMOTE_REJECTED')
	assert.equal(environment.data.push115_bridge_jobs['job-real-offline'].status, 'failed')
	assert.equal(environment.tasks.length, 0)
})
