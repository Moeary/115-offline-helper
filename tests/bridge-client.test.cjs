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
	load('shared/download-intent.js')
	context.Push115.Background = {
		TaskStore: {
			read: taskStoreRead,
			cancel: async taskId => {
				const tasks = Array.isArray(data.push115_tasks) ? data.push115_tasks : []
				const task = tasks.find(item => String(item?.taskId || '') === String(taskId || ''))
				if (!task) return null
				if (['waiting', 'processing'].includes(task.status)) {
					task.status = 'cancelled'
					task.monitorDownload = false
					task.metadata = { ...(task.metadata || {}), monitorDownload: false }
					delete task.beforeSnapshot
					delete task.directPlan
					delete task.animeTransfer
					delete task.remoteFolderCid
					delete task.directFileId
					delete task.directFileCid
					delete task.percent
					task.message = '已在本地停止后处理与监控；115 云端离线任务未取消'
				}
				return task
			},
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
		url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=ABC-123',
		title: 'ABC-123',
		sourceSite: 'javbus',
		mediaType: 'jav',
		processorProfile: 'jav',
		code: 'ABC-123',
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

test('directory registry sync uses the authenticated loopback PUT contract', async () => {
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async () => response({ schema: 1, revision: 4 }),
	})
	const result = await e.client.syncDirectoryRegistry({
		schema: 1,
		revision: 4,
		scannedAt: 123,
		roots: ['0'],
		directories: [{ cid: '42', parentCid: '0', name: '影视', path: '/影视', depth: 1 }],
	})
	assert.equal(result.revision, 4)
	assert.equal(e.calls[0][0], 'http://127.0.0.1:52115/v1/runtime/directories')
	assert.equal(e.calls[0][1].method, 'PUT')
	assert.equal(e.calls[0][1].headers.Authorization, 'Bearer secret-token')
	assert.deepEqual(JSON.parse(e.calls[0][1].body).directories, [{
		cid: '42', parentCid: '0', name: '影视', path: '/影视', depth: 1,
	}])
})

test('directory registry sync reconciles a stale local revision with the bridge', async () => {
	let putCount = 0
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (_url, request) => {
			if (request.method === 'PUT' && putCount++ === 0) {
				return response({ detail: { code: 'directory_registry_stale', revision: 27 } }, 409)
			}
			if (request.method === 'GET') return response({ schema: 1, registry: { revision: 27 }, revision: 27 })
			return response({ schema: 1, revision: 28, updated: true })
		},
	})
	const writes = []
	e.context.Push115.Background.DirectoryIndex = {
		normalizeIndex: value => value,
		write: async value => { writes.push(value) },
	}
	const result = await e.client.syncDirectoryRegistry({
		schema: 1,
		revision: 1,
		scannedAt: 123,
		roots: ['0'],
		directories: [{ cid: '42', parentCid: '0', name: '影视', path: '/影视', depth: 1 }],
	})
	assert.equal(result.reconciled, true)
	assert.equal(result.revision, 28)
	assert.deepEqual(e.calls.map(([, request]) => request.method), ['PUT', 'GET', 'PUT'])
	assert.equal(JSON.parse(e.calls[2][1].body).revision, 28)
	assert.equal(writes.length, 1)
	assert.equal(writes[0].revision, 28)
})

test('directory registry sync rejects an oversized UTF-8 payload before fetch', async () => {
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
	})
	const directories = Array.from({ length: 4000 }, (_item, index) => ({
		cid: String(index + 1),
		parentCid: '0',
		name: `目录-${index}-${'长'.repeat(256)}`,
		path: `/目录-${index}-${'长'.repeat(256)}`,
		depth: 1,
	}))
	await assert.rejects(
		e.client.syncDirectoryRegistry({ schema: 1, revision: 1, scannedAt: 123, roots: ['0'], directories }),
		error => error?.code === 'BRIDGE_DIRECTORY_PAYLOAD_TOO_LARGE',
	)
	assert.equal(e.calls.length, 0)
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
			if (url.endsWith('/v1/jobs/claim')) workerIds.push(JSON.parse(request.body).workerId)
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

test('claim preserves only the explicit Nyaa Anime route and removes nested secrets', async () => {
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token', push115_bridge_target_cid: '42' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) return response({ schema: 1 })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = {
		...job('anime-job'),
		intent: {
			url: 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefab',
			title: 'Anime 01',
			sourceSite: 'nyaa',
			mediaType: 'anime',
			processorProfile: 'anime',
			code: 'SHOULD-BE-CLEARED',
			metadata: {
				provider: 'nyaa',
				originalTitle: 'Anime 01',
				credentials: { token: 'do-not-forward' },
				cookie: 'do-not-forward',
			},
		},
	}
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 1)
	assert.equal(e.routerCalls[0].sourceSite, 'nyaa')
	assert.equal(e.routerCalls[0].mediaType, 'anime')
	assert.equal(e.routerCalls[0].processorProfile, 'anime')
	assert.equal(e.routerCalls[0].code, '')
	assert.equal(e.routerCalls[0].metadata.provider, 'nyaa')
	assert.equal(e.routerCalls[0].metadata.credentials, undefined)
	assert.equal(e.routerCalls[0].metadata.cookie, undefined)
})

test('generic canonical intent accepts a non-hardcoded source and uses the Bridge default CID', () => {
	const e = environment()
	const intent = e.client.safeIntent({
		url: 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefab&dn=Anime+01',
		title: 'Anime 01',
		sourceSite: 'mikan',
		mediaType: 'anime',
		processorProfile: 'anime',
		metadata: {
			provider: 'mikan',
			pageUrl: 'https://mikan.example/episode/1',
			secret: 'drop-me',
			headers: { Authorization: 'drop-me' },
			animeTarget: { cid: 'unsafe' },
			skipSubmitted: false,
		},
	}, 'mikan-job', '42')
	assert.equal(intent.sourceSite, 'mikan')
	assert.equal(intent.mediaType, 'anime')
	assert.equal(intent.processorProfile, 'anime')
	assert.equal(intent.savePathCid, '42')
	assert.equal(intent.linkType, 'magnet')
	assert.equal(intent.metadata.provider, 'mikan')
	assert.equal(intent.metadata.bridgeJobId, 'mikan-job')
	assert.equal(intent.metadata.monitorDownload, true)
	assert.equal(intent.metadata.secret, undefined)
	assert.equal(intent.metadata.headers, undefined)
	assert.equal(intent.metadata.animeTarget, undefined)
	assert.equal(intent.metadata.skipSubmitted, undefined)
})

test('generic canonical intent preserves ED2K link identity and expected fields', () => {
	const e = environment()
	const url = 'ed2k://|file|%5BGroup%5D%20sample.mp4|789|ABCDEF0123456789ABCDEF0123456789|/'
	const intent = e.client.safeIntent({
		url,
		sourceSite: 'southplus',
		mediaType: 'generic',
		processorProfile: 'generic',
	}, 'ed2k-job', '42')
	assert.equal(intent.linkType, 'ed2k')
	assert.equal(intent.expectedName, '[Group] sample.mp4')
	assert.equal(intent.expectedSize, 789)
	assert.equal(intent.expectedHash, 'abcdef0123456789abcdef0123456789')
	assert.equal(intent.metadata.ed2kFileName, '[Group] sample.mp4')
	assert.equal(intent.metadata.ed2kSize, 789)
	assert.equal(intent.metadata.ed2kHash, 'abcdef0123456789abcdef0123456789')
})

test('Bridge default CID only fills a missing value and keeps explicit root or numeric CIDs', () => {
	const e = environment()
	const base = {
		url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
		sourceSite: 'generic',
		mediaType: 'generic',
		processorProfile: 'generic',
	}
	assert.equal(e.client.safeIntent(base, 'cid-missing', '42').savePathCid, '42')
	assert.equal(e.client.safeIntent({ ...base, savePathCid: '0' }, 'cid-root', '42').savePathCid, '0')
	assert.equal(e.client.safeIntent({ ...base, savePathCid: '123' }, 'cid-explicit', '42').savePathCid, '123')
	assert.throws(() => e.client.safeIntent({ ...base, savePathCid: 'not-a-cid' }, 'cid-invalid', '42'), error => error?.code === 'BRIDGE_INVALID_INTENT')
})

test('canonical bridge validation rejects invalid source/profile and Jav intents without a code', () => {
	const e = environment()
	const base = {
		url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
		sourceSite: 'generic',
		mediaType: 'generic',
		processorProfile: 'generic',
	}
	assert.throws(() => e.client.safeIntent({ ...base, sourceSite: 'bad source' }, 'invalid-source', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...base, processorProfile: 'unknown' }, 'invalid-profile', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...base, processorProfile: 'jav' }, 'missing-code', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
})

test('Bridge rejects non-BTIH magnets and enforces server field limits', () => {
	const e = environment()
	const base = {
		url: 'magnet:?xt=urn:foo:0123456789abcdef0123456789abcdef01234567',
		sourceSite: 'generic', mediaType: 'generic', processorProfile: 'generic',
	}
	assert.throws(() => e.client.safeIntent(base, 'non-btih', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	for (const invalidPrefix of ['0', '1', '8', '9']) {
		assert.throws(() => e.client.safeIntent({ ...base, url: `magnet:?xt=urn:btih:${invalidPrefix.repeat(32)}` }, `invalid-btih-${invalidPrefix}`, '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	}
	const valid = {
		url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
		sourceSite: 'generic', mediaType: 'generic', processorProfile: 'generic',
	}
	assert.throws(() => e.client.safeIntent({ ...valid, code: 'A'.repeat(65) }, 'long-code', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...valid, expectedName: 'N'.repeat(1025) }, 'long-name', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...valid, metadata: { expectedName: 'N'.repeat(1025) } }, 'metadata-long-name', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...valid, metadata: { fileName: 'N'.repeat(1025) } }, 'metadata-long-file-name', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...valid, metadata: { ed2kFileName: 'N'.repeat(1025) } }, 'metadata-long-ed2k-file-name', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	const maxSize = '9223372036854775807'
	assert.equal(e.client.safeIntent({ ...valid, expectedSize: maxSize }, 'max-size', '0').expectedSize, maxSize)
	assert.throws(() => e.client.safeIntent({ ...valid, expectedSize: '9223372036854775808' }, 'large-size', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...valid, metadata: { expectedSize: '9223372036854775808' } }, 'metadata-large-size', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent(valid, 'long-cid', '1'.repeat(65)), error => error?.code === 'BRIDGE_INVALID_INTENT')
})

test('Bridge canonicalizes strict ED2K fields and rejects embedded whitespace or oversized links', () => {
	const e = environment()
	const base = { sourceSite: 'generic', mediaType: 'generic', processorProfile: 'generic' }
	const padded = 'ed2k://|file|sample%20file.mkv|000123|abcdef0123456789abcdef0123456789|/'
	const intent = e.client.safeIntent({ ...base, url: padded, metadata: {
		fileName: 'wrong-name', ed2kFileName: 'wrong-name', ed2kSize: '999', ed2kHash: '0123456789abcdef0123456789abcdef',
	} }, 'ed2k-padded', '0')
	assert.equal(intent.expectedName, 'sample file.mkv')
	assert.equal(intent.expectedSize, 123)
	assert.equal(intent.metadata.fileName, 'sample file.mkv')
	assert.equal(intent.metadata.ed2kFileName, 'sample file.mkv')
	assert.equal(intent.metadata.ed2kSize, 123)
	assert.equal(intent.metadata.ed2kHash, 'abcdef0123456789abcdef0123456789')
	const longName = 'N'.repeat(600)
	const longNameIntent = e.client.safeIntent({ ...base, url: `ed2k://|file|${encodeURIComponent(longName)}|123|abcdef0123456789abcdef0123456789|/` }, 'ed2k-long-title', '0')
	assert.equal(longNameIntent.expectedName, longName)
	assert.equal(longNameIntent.title, longName.slice(0, 512))
	const oversizedFileName = encodeURIComponent('N'.repeat(1025))
	assert.throws(() => e.client.safeIntent({ ...base, url: `ed2k://|file|${oversizedFileName}|123|abcdef0123456789abcdef0123456789|/` }, 'ed2k-long-name', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...base, url: 'ed2k://|file|sample|12 3|abcdef0123456789abcdef0123456789|/' }, 'ed2k-space', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...base, url: 'ed2k://|file|sample|9223372036854775808|abcdef0123456789abcdef0123456789|/' }, 'ed2k-large', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
	assert.throws(() => e.client.safeIntent({ ...base, url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', expectedSize: '12 3' }, 'size-space', '0'), error => error?.code === 'BRIDGE_INVALID_INTENT')
})

test('deeply nested bridge secrets are truncated before Router submission', async () => {
	const deep = {}
	let cursor = deep
	for (let index = 0; index < 9; index += 1) {
		cursor.next = {}
		cursor = cursor.next
	}
	cursor.token = 'deep-secret-must-not-appear'
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) return response({ schema: 1 })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = {
		...job('deep-secret-job'),
		intent: {
			...job('deep-secret-job').intent,
			sourceSite: 'javbus',
			mediaType: 'jav',
			processorProfile: 'jav',
			code: 'ABC-123',
			metadata: { deep },
		},
	}
	await e.client.processPending()
	assert.equal(e.routerCalls.length, 1)
	assert.equal(JSON.stringify(e.routerCalls[0]).includes('deep-secret-must-not-appear'), false)
})

test('invalid bridge intent source label is rejected before Router submission', async () => {
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/claim')) return response({ schema: 1, job: e.pendingJob })
			if (url.includes('/events')) return response({ schema: 1 })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	e.pendingJob = {
		...job('invalid-route-job'),
		intent: {
			...job('invalid-route-job').intent,
			sourceSite: 'Nyaa Source',
			mediaType: 'jav',
			processorProfile: 'jav',
			code: 'ABC-123',
		},
	}
	const result = await e.client.processPending()
	assert.equal(result.error, 'BRIDGE_INVALID_INTENT')
	assert.equal(e.routerCalls.length, 0)
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
	assert.equal(e.calls.length, 1)
	assert.equal(e.calls[0][0], 'http://127.0.0.1:52115/v1/actions/claim')
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

function actionClaim(actionId, jobId, taskId, overrides = {}) {
	return {
		actionId,
		jobId,
		actionType: 'cancel_task',
		type: 'cancel_task',
		leaseId: `${actionId}-lease`,
		...overrides,
		job: {
			jobId,
			taskId,
			status: 'accepted',
			...(overrides.job || {}),
		},
	}
}

test('cancel_task applies to the exact local task and never calls the 115 Router', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_tasks: [{ taskId: 'local-target', status: 'processing', percent: 60, metadata: { bridgeJobId: 'cancel-job' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: actionClaim('action-1', 'cancel-job', 'local-target') })
			if (url.includes('/v1/actions/action-1/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	const result = await e.client.processPending()
	assert.equal(result.actionId, 'action-1')
	assert.equal(events[0].state, 'applied')
	assert.equal(events[0].result.taskId, 'local-target')
	assert.equal(events[0].result.localTaskFound, true)
	assert.equal(e.data.push115_tasks[0].status, 'cancelled')
	assert.equal(e.data.push115_tasks[0].percent, undefined)
	assert.equal(e.routerCalls.length, 0)
	assert.equal((await e.client.readJobs())['cancel-job'].status, 'cancelled')
})

test('cancel_task with a null taskId resolves the unique local task by bridge job ID', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_tasks: [{ taskId: 'mapped-task', status: 'waiting', metadata: { bridgeJobId: 'mapped-job' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: actionClaim('action-null-task', 'mapped-job', null) })
			if (url.includes('/v1/actions/action-null-task/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(events[0].state, 'applied')
	assert.equal(events[0].result.taskId, 'mapped-task')
	assert.equal(e.data.push115_tasks[0].status, 'cancelled')
})

test('cancel_task returns noop for an already terminal Bridge job and failed for an unknown action type', async () => {
	const events = []
	let calls = 0
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) {
				calls += 1
				if (calls === 1) return response({ schema: 1, action: actionClaim('action-noop', 'done-job', 'missing-task', { job: { status: 'completed' } }) })
				return response({ schema: 1, action: actionClaim('action-unknown', 'unknown-job', null, { actionType: 'delete_task', type: 'delete_task' }) })
			}
			if (url.includes('/v1/actions/') && url.endsWith('/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	await e.client.processPending()
	assert.equal(events[0].state, 'noop')
	assert.equal(events[1].state, 'failed')
	assert.equal(events[1].errorCode, 'UNSUPPORTED_ACTION')
})

test('malformed action payload is durably failed and acknowledged after claim', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: {
				actionId: 'malformed-action', jobId: 'malformed-job', leaseId: 'malformed-lease', actionType: 'cancel_task',
			} })
			if (url.includes('/v1/actions/malformed-action/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(events[0].state, 'failed')
	assert.equal(events[0].errorCode, 'ACTION_JOB_MISSING')
	assert.equal((await e.client.readActions())['malformed-action'].status, 'failed')
})

test('action claim rejects conflicting nested job and type fields with a terminal ACK', async () => {
	const events = []
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: {
				actionId: 'conflict-action', jobId: 'job-a', leaseId: 'conflict-lease',
				actionType: 'cancel_task', type: 'other_task',
				job: { jobId: 'job-b', taskId: 'task-a', status: 'accepted' },
			} })
			if (url.includes('/v1/actions/conflict-action/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(events[0].state, 'failed')
	assert.equal(events[0].errorCode, 'ACTION_JOB_INVALID')
})

test('action event outbox retries with the same event ID after a worker restart', async () => {
	let fail = true
	const events = []
	const data = {
		push115_bridge_enabled: true,
		push115_bridge_token: 'secret-token',
		push115_tasks: [{ taskId: 'restart-task', status: 'processing', metadata: { bridgeJobId: 'restart-job' } }],
	}
	const e = environment({
		data,
		fetchHandler: async (url, request) => {
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: actionClaim('restart-action', 'restart-job', 'restart-task') })
			if (url.includes('/v1/actions/restart-action/events')) {
				events.push(JSON.parse(request.body))
				if (fail) throw new Error('bridge unavailable')
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	const firstEventId = events[0].eventId
	assert.equal((await e.client.readActionOutbox())[0].eventId, firstEventId)
	fail = false
	await e.client.processPending()
	assert.equal(events[1].eventId, firstEventId)
	assert.deepEqual(await e.client.readActionOutbox(), [])
	assert.equal((await e.client.readActions())['restart-action'].status, 'applied')
})

test('a running cancel_task is safely re-executed after restart', async () => {
	const events = []
	const e = environment({
		data: {
			push115_bridge_enabled: true,
			push115_bridge_token: 'secret-token',
			push115_bridge_actions: {
				'running-action': {
					actionId: 'running-action', jobId: 'running-job', leaseId: 'running-lease', actionType: 'cancel_task',
					taskId: 'running-task', jobStatus: 'accepted', status: 'running',
				},
			},
			push115_tasks: [{ taskId: 'running-task', status: 'processing', metadata: { bridgeJobId: 'running-job' } }],
		},
		fetchHandler: async (url, request) => {
			if (url.includes('/v1/actions/running-action/events')) {
				events.push(JSON.parse(request.body))
				return response({ schema: 1 })
			}
			if (url.endsWith('/v1/actions/claim')) return response({ schema: 1, action: null })
			if (url.endsWith('/v1/jobs/claim')) return response({ schema: 1, job: null })
			throw new Error(`unexpected URL ${url}`)
		},
	})
	await e.client.processPending()
	assert.equal(events[0].state, 'applied')
	assert.equal(e.data.push115_tasks[0].status, 'cancelled')
	assert.equal((await e.client.readActions())['running-action'].status, 'applied')
})

test('concurrent alarm calls collapse into one poll', async () => {
	let claimCount = 0
	const e = environment({
		data: { push115_bridge_enabled: true, push115_bridge_token: 'secret-token' },
		fetchHandler: async url => {
		if (url.endsWith('/v1/jobs/claim')) {
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
