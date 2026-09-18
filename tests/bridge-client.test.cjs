const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function response(body, status = 200, extras = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		redirected: false,
		text: async () => JSON.stringify(body),
		...extras,
	}
}

function environment(options = {}) {
	const data = structuredClone(options.data || {})
	const calls = []
	let permissionGranted = options.permissionGranted !== false
	let fetchHandler = options.fetchHandler || (async () => response({ schema: 1, job: null }))
	let routerCalls = []
	const taskStoreRead = options.taskStoreRead || (async () => Array.isArray(data.push115_tasks) ? data.push115_tasks : [])
	const customSubmitIntent = options.submitIntent || null
	const context = vm.createContext({
		console,
		Date,
		Promise,
		URL,
		URLSearchParams,
		structuredClone,
		setTimeout: options.setTimeout || setTimeout,
		clearTimeout,
		AbortController,
		crypto: require('node:crypto').webcrypto,
		fetch: async (...args) => {
			calls.push(args)
			return fetchHandler(...args)
		},
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return structuredClone(data)
						const requested = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {})
						return Object.fromEntries(requested.map(key => [key, structuredClone(data[key])]))
					},
					async set(values) { Object.assign(data, structuredClone(values)) },
				},
			},
			runtime: { id: 'test-extension-id' },
			permissions: {
				contains: async () => permissionGranted,
				request: async () => permissionGranted,
			},
			alarms: {
				get: async () => null,
				create: async () => {},
				clear: async () => true,
			},
		},
	})
	const load = relative => vm.runInContext(
		fs.readFileSync(path.join(extension, relative), 'utf8'),
		context,
		{ filename: relative },
	)
	load('shared/config.js')
	context.Push115.Background = {
		TaskStore: {
			read: taskStoreRead,
			persist: async task => {
				const tasks = Array.isArray(data.push115_tasks) ? data.push115_tasks : []
				const index = tasks.findIndex(item => item.taskId === task.taskId)
				if (index >= 0) tasks[index] = task
				else tasks.unshift(task)
				data.push115_tasks = tasks
			},
			appendLog: (task, message) => { task.message = message },
		},
		TaskMonitor: { ensureAlarm: async () => {} },
		Router: {
			submitIntent: async intent => {
				routerCalls.push(intent)
				if (customSubmitIntent) return customSubmitIntent(intent)
				const task = {
					taskId: `task-${routerCalls.length}`,
					remoteId: 'remote-1',
					status: 'waiting',
					message: '',
					metadata: { ...intent.metadata },
				}
				data.push115_tasks = [task]
				return { task }
			},
		},
	}
	load('background/bridge-client.js')
	return {
		context,
		data,
		calls,
		routerCalls,
		setPermission(value) { permissionGranted = value },
		setFetchHandler(handler) { fetchHandler = handler },
		client: context.Push115.Background.BridgeClient,
	}
}

const job = (jobId = 'job-1') => ({
	jobId,
	leaseId: 'lease-1',
	intent: {
		url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef&dn=ABC-123',
		title: 'ABC-123',
	},
})

test('content-facing loadConfig does not expose the local bridge token', async () => {
	const e = environment({ data: {
		push115_bridge_token: 'keep-this-private',
		push115_bridge_enabled: true,
		push115_site_profiles: { javbus: { enabled: false } },
	} })
	const config = await e.context.Push115.Config.loadConfig()
	assert.equal(config.push115_bridge_token, undefined)
	assert.equal(config.push115_bridge_jobs, undefined)
	assert.equal(config.push115_bridge_enabled, undefined)
	assert.equal(config.push115_site_profiles.javbus.enabled, false)
})

test('bridge transport uses the fixed URL, bearer header, omit credentials, and error redirects', async () => {
	const e = environment({ fetchHandler: async () => response({ schema: 1, job: null }) })
	await e.client.requestJson('/v1/jobs/claim', { schema: 1 }, 'secret-token')
	assert.equal(e.calls[0][0], 'http://127.0.0.1:52115/v1/jobs/claim')
	const request = e.calls[0][1]
	assert.equal(request.headers.Authorization, 'Bearer secret-token')
	assert.equal(request.credentials, 'omit')
	assert.equal(request.redirect, 'error')
	assert.equal(Object.prototype.hasOwnProperty.call(request.headers, 'Cookie'), false)
	await assert.rejects(e.client.requestJson('https://example.com/v1/jobs/claim', {}, 'secret-token'), /路径无效/)
	assert.equal(e.calls.length, 1)
})

test('bridge response body remains covered by the abort timeout', async () => {
	let aborted = false
	const e = environment({
		// Shorten the production timeout for this test while retaining the
		// AbortController and body-stream sequence.
		setTimeout: callback => setTimeout(callback, 0),
		fetchHandler: async (_url, request) => ({
			status: 200,
			ok: true,
			redirected: false,
			text: () => new Promise((_resolve, reject) => {
				const onAbort = () => {
					aborted = true
					const error = new Error('aborted')
					error.name = 'AbortError'
					reject(error)
				}
				if (request.signal.aborted) onAbort()
				else request.signal.addEventListener('abort', onAbort, { once: true })
			}),
		}),
	})
	const request = e.client.requestJson('/v1/jobs/claim', { schema: 1 }, 'secret-token')
	const bounded = Promise.race([
		request,
		new Promise((_, reject) => setTimeout(() => reject(new Error('body timeout test exceeded')), 100)),
	])
	await assert.rejects(bounded, error => error?.code === 'BRIDGE_TIMEOUT' && error.uncertain === true)
	assert.equal(aborted, true)
})

test('disabled bridge makes no local request', async () => {
	const e = environment({ data: { push115_bridge_enabled: false, push115_bridge_token: 'secret-token' } })
	const result = await e.client.processPending()
	assert.equal(result.disabled, true)
	assert.equal(e.calls.length, 0)
})

test('bridge worker id is a stable random per-profile value', async () => {
	const workerIds = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) workerIds.push(JSON.parse(request.body).workerId)
			return response({ schema: 1, job: null })
		},
	})
	await e.client.processPending()
	await e.client.processPending()
	assert.equal(workerIds.length, 2)
	assert.equal(workerIds[0], workerIds[1])
	assert.notEqual(workerIds[0], 'test-extension-id')
	assert.match(workerIds[0], /^test-extension-id-/)
	assert.equal(e.data.push115_bridge_worker_id, workerIds[0])
})

test('claim submits once with explicit jav profile, target CID, and monitor metadata', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token', push115_bridge_target_cid: '42' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1, accepted: true })
			}
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = job()
	const result = await e.client.processPending()
	assert.equal(result.jobId, 'job-1')
	assert.equal(e.routerCalls.length, 1)
	assert.equal(e.routerCalls[0].processorProfile, 'jav')
	assert.equal(e.routerCalls[0].mediaType, 'jav')
	assert.equal(e.routerCalls[0].savePathCid, '42')
	assert.equal(e.routerCalls[0].metadata.bridgeJobId, 'job-1')
	assert.equal(e.routerCalls[0].metadata.monitorDownload, true)
	assert.equal(events[0].state, 'accepted')
	assert.equal(events[0].taskId, 'task-1')
	assert.deepEqual(await e.client.readOutbox(), [])
	// A repeated claim for the same job can reconcile the existing local task,
	// but must never call Router.submitIntent a second time.
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 1)
})

test('generic Router submission errors become uncertain after the submission boundary', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		submitIntent: async () => {
			// A local TaskStore/quota failure can happen after 115 accepted the
			// task, so this error carries no evidence of remote rejection.
			throw new Error('本地任务持久化失败')
		},
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = job()
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 1)
	assert.equal((await e.client.readJobs())['job-1'].status, 'uncertain')
	assert.equal(events[0].state, 'uncertain')
})

test('explicit remote rejection remains a failed bridge job', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		submitIntent: async () => {
			const error = new Error('115 拒绝离线任务')
			error.code = 'REMOTE_REJECTED'
			error.remoteRejected = true
			throw error
		},
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = job()
	await e.client.processPending()
	assert.equal((await e.client.readJobs())['job-1'].status, 'failed')
	assert.equal(events[0].state, 'failed')
	assert.equal(events[0].errorCode, 'REMOTE_REJECTED')
})

test('submitting job with no recoverable task becomes uncertain and is never resubmitted', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_jobs: { 'job-1': { ...job(), status: 'submitting' } },
		},
		fetchHandler: async (url, request) => {
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			return response({ schema: 1, job: null })
		},
	})
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 0)
	assert.equal(events[0].state, 'uncertain')
	assert.equal((await e.client.readJobs())['job-1'].status, 'uncertain')
})

test('recovered expired claim without a local task becomes uncertain and is never resubmitted', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) {
				return response({ schema: 1, job: {
					...job(),
					status: 'claimed',
					recovered: true,
					attemptCount: 2,
					taskId: 'task-lost',
					remoteId: 'remote-lost',
				} })
			}
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 0)
	assert.equal((await e.client.readJobs())['job-1'].status, 'uncertain')
	assert.equal(events[0].state, 'uncertain')
	assert.equal(events[0].taskId, 'task-lost')
})

test('recovered progress claim reconciles a local task without replaying accepted', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_tasks: [{ taskId: 'task-1', remoteId: 'remote-1', status: 'processing', percent: 40, message: '115 下载中', metadata: { bridgeJobId: 'job-1' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) {
				return response({ schema: 1, job: {
					...job(),
					status: 'progress',
					recovered: true,
					attemptCount: 2,
					taskId: 'task-1',
					remoteId: 'remote-1',
				} })
			}
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 0)
	assert.equal(events.filter(item => item.state === 'accepted').length, 0)
	assert.equal(events.filter(item => item.state === 'progress').length, 1)
	assert.equal(events[0].taskId, 'task-1')
})

test('TaskStore read failure prevents claiming or resubmitting a bridge job', async () => {
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_jobs: { 'job-1': { ...job(), status: 'claimed' } },
		},
		taskStoreRead: async () => { throw new Error('storage unavailable') },
	})
	const result = await e.client.processPending()
	assert.equal(result.error, 'BRIDGE_POLL_FAILED')
	assert.equal(e.routerCalls.length, 0)
	assert.equal(e.calls.length, 0)
	assert.equal((await e.client.readJobs())['job-1'].status, 'claimed')
})

test('event outbox survives a network failure with a stable event id', async () => {
	let fail = true
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_jobs: { 'job-1': { ...job(), status: 'accepted', acceptedSent: true, taskId: 'task-1' } },
			push115_tasks: [{ taskId: 'task-1', status: 'waiting', message: '' , metadata: { bridgeJobId: 'job-1' } }],
			push115_bridge_outbox: [{
				eventId: 'event-stable', jobId: 'job-1', createdAt: 1, attempts: 0, nextAttemptAt: 0,
				payload: { schema: 1, leaseId: 'lease-1', eventId: 'event-stable', state: 'progress', taskId: 'task-1' },
			}],
		},
		fetchHandler: async (url, request) => {
			if (url.includes('/events')) {
				if (fail) throw new Error('offline')
				assert.equal(JSON.parse(request.body).eventId, 'event-stable')
				return response({ schema: 1 })
			}
			return response({ schema: 1, job: null })
		},
	})
	const first = await e.client.processPending()
	assert.equal(first.outboxPending, true)
	assert.equal((await e.client.readOutbox())[0].eventId, 'event-stable')
	fail = false
	await e.client.processPending()
	assert.deepEqual(await e.client.readOutbox(), [])
})

test('outbox capacity preserves every accepted and terminal event', async () => {
	const durable = Array.from({ length: 205 }, (_value, index) => ({
		eventId: `durable-${index}`,
		jobId: `job-${index}`,
		createdAt: index + 1,
		attempts: 0,
		nextAttemptAt: 0,
		payload: {
			schema: 1,
			leaseId: 'lease-1',
			eventId: `durable-${index}`,
			state: ['accepted', 'completed', 'failed', 'uncertain'][index % 4],
		},
	}))
	const progress = Array.from({ length: 4 }, (_value, index) => ({
		eventId: `progress-${index}`,
		jobId: `progress-job-${index}`,
		createdAt: 300 + index,
		payload: {
			schema: 1,
			leaseId: 'lease-1',
			eventId: `progress-${index}`,
			state: 'progress',
			percent: index,
		},
	}))
	const e = environment({
		data: {
			push115_bridge_jobs: { 'job-keep': { ...job('job-keep'), status: 'accepted' } },
			push115_bridge_outbox: [...durable, ...progress],
		},
	})
	await e.client.enqueueEvent('job-keep', 'uncertain', { errorCode: 'TEST' }, { status: 'uncertain' })
	const outbox = await e.client.readOutbox()
	const eventIds = new Set(outbox.map(item => item.eventId))
	for (const item of durable) assert.equal(eventIds.has(item.eventId), true, item.eventId)
	assert.equal(eventIds.has('event-should-not-exist'), false)
	assert.equal(outbox.some(item => item.payload.state === 'uncertain' && item.jobId === 'job-keep'), true)
})

test('accepted event is deduplicated across multiple reconciliation rounds', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_jobs: { 'job-1': { ...job(), status: 'accepted', acceptedSent: false } },
			push115_tasks: [{ taskId: 'task-1', status: 'waiting', message: '', metadata: { bridgeJobId: 'job-1' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			return response({ schema: 1, job: null })
		},
	})
	await e.client.processPending()
	await e.client.processPending()
	await e.client.processPending()
	assert.equal(events.filter(item => item.state === 'accepted').length, 1)
	assert.equal((await e.client.readJobs())['job-1'].acceptedSent, true)
})

test('recorded local history reports progress and never completed', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_jobs: { 'job-1': { ...job(), status: 'accepted', acceptedSent: true, taskId: 'task-1' } },
			push115_tasks: [{ taskId: 'task-1', status: 'recorded', message: '仅保存本地历史', metadata: { bridgeJobId: 'job-1' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.includes('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			return response({ schema: 1, job: null })
		},
	})
	await e.client.processPending()
	assert.ok(events.some(item => item.state === 'progress'))
	assert.equal(events.some(item => item.state === 'completed'), false)
})

test('concurrent alarm calls collapse into one poll', async () => {
	let claimCount = 0
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async url => {
			if (url.endsWith('/claim')) {
				claimCount += 1
				await new Promise(resolve => setTimeout(resolve, 10))
			}
			return response({ schema: 1, job: null })
		},
	})
	const [first, second] = await Promise.all([e.client.processPending(), e.client.processPending()])
	assert.equal(claimCount, 1)
	assert.equal(second.skipped, true)
	assert.equal(first.empty, true)
})
