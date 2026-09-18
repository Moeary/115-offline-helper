;(function (global) {
	'use strict'

	const push115 = global.Push115 = global.Push115 || {}
	const background = push115.Background = push115.Background || {}
	const configApi = push115.Config || {}
	const storageKeys = configApi.STORAGE_KEYS || {}

	// Keep the bridge transport intentionally small and fixed.  The extension
	// never accepts a bridge URL from a page or from the local bridge itself.
	const BASE_URL = String(configApi.BRIDGE_BASE_URL || 'http://127.0.0.1:52115').replace(/\/$/, '')
	const ORIGIN = String(configApi.BRIDGE_ORIGIN || 'http://127.0.0.1:52115')
	const HOST_PERMISSION = String(configApi.BRIDGE_HOST_PERMISSION || 'http://127.0.0.1/*')
	const ALARM_NAME = 'push115-bridge-poll'
	const PERIOD_MINUTES = 0.5
	const LEASE_SECONDS = 120
	const REQUEST_TIMEOUT_MS = 15000
	const MAX_OUTBOX = 200
	const MAX_JOBS = 500
	const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'uncertain', 'cancelled'])
	const TERMINAL_ACTION_STATES = new Set(['applied', 'failed', 'uncertain', 'noop'])
	const ACTION_TYPES = new Set(['cancel_task'])
	const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
	const MAX_INT64 = 9223372036854775807n
	const INTENT_MEDIA_TYPES = new Set(['generic', 'jav', 'anime'])
	const INTENT_PROCESSOR_PROFILES = new Set(['generic', 'jav', 'anime'])
	const SAFE_SOURCE_SITE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
	const BRIDGE_METADATA_KEYS = new Set([
		'provider', 'pageUrl', 'coverUrl', 'originalTitle', 'candidateTitle', 'detailUrl', 'guid',
		'btih', 'fileName', 'ed2kFileName', 'ed2kSize', 'ed2kHash', 'expectedName', 'expectedSize',
		'expectedHash', 'pageCode', 'linkType', 'monitorDownload',
	])
	const BRIDGE_METADATA_TEXT_KEYS = new Set([
		'provider', 'pageUrl', 'coverUrl', 'originalTitle', 'candidateTitle', 'detailUrl', 'guid',
		'btih', 'fileName', 'ed2kFileName', 'ed2kHash', 'expectedName', 'expectedHash', 'pageCode',
		'linkType',
	])
	const BRIDGE_METADATA_NUMBER_KEYS = new Set(['ed2kSize', 'expectedSize'])
	const BRIDGE_METADATA_BOOLEAN_KEYS = new Set(['monitorDownload'])
	let running = false
	let mutationChain = Promise.resolve()
	let workerIdPromise = null

	function serial(work) {
		const result = mutationChain.catch(() => {}).then(work)
		mutationChain = result.catch(() => {})
		return result
	}

	function storage() {
		return chrome.storage?.local
	}

	async function getStorage(key) {
		if (!storage()?.get) return {}
		return (await storage().get(key)) || {}
	}

	async function setStorage(values) {
		if (!storage()?.set) throw new Error('扩展存储不可用')
		return storage().set(values)
	}

	function key(name, fallback) {
		return storageKeys[name] || fallback
	}

	const ENABLED_KEY = key('BRIDGE_ENABLED', 'push115_bridge_enabled')
	const TOKEN_KEY = key('BRIDGE_TOKEN', 'push115_bridge_token')
	const TARGET_CID_KEY = key('BRIDGE_TARGET_CID', 'push115_bridge_target_cid')
	const JOBS_KEY = key('BRIDGE_JOBS', 'push115_bridge_jobs')
	const OUTBOX_KEY = key('BRIDGE_OUTBOX', 'push115_bridge_outbox')
	const TASKS_KEY = key('TASKS', 'push115_tasks')
	const ACTIONS_KEY = key('BRIDGE_ACTIONS', 'push115_bridge_actions')
	const ACTION_OUTBOX_KEY = key('BRIDGE_ACTION_OUTBOX', 'push115_bridge_action_outbox')

	function normalizeCid(value, fallback = '0') {
		if (typeof configApi.normalizeCid === 'function') return configApi.normalizeCid(value, fallback)
		const text = String(value ?? '').trim()
		return /^\d+$/.test(text) ? text : fallback
	}

	function now() {
		return Date.now()
	}

	function makeId(prefix) {
		try {
			if (global.crypto?.randomUUID) return global.crypto.randomUUID()
			if (crypto?.randomUUID) return crypto.randomUUID()
		} catch (error) {
			// The fallback below is sufficient for old Chrome/test shims.  IDs are
			// persisted before they are sent, so a retry keeps the same value.
		}
		return `${prefix}-${now()}-${Math.random().toString(16).slice(2)}`
	}

	function scrub(value, limit = 500) {
		const text = String(value || '').trim()
		return text.length > limit ? `${text.slice(0, limit)}…` : text
	}

	function scrubWithToken(value, token) {
		const text = scrub(value)
		return token && text.includes(token) ? text.split(token).join('[redacted]') : text
	}

	function errorCode(error, fallback = 'BRIDGE_ERROR') {
		const raw = String(error?.code || fallback).trim().toUpperCase()
		return /^[A-Z0-9_.:-]{1,80}$/.test(raw) ? raw : fallback
	}

	function bridgeError(message, code = 'BRIDGE_ERROR', options = {}) {
		const error = new Error(String(message || 'bridge 请求失败'))
		error.code = code
		if (options.uncertain) error.uncertain = true
		if (options.status !== undefined) error.status = options.status
		return error
	}

	async function readConfig() {
		const values = await getStorage([
			ENABLED_KEY,
			TOKEN_KEY,
			TARGET_CID_KEY,
		])
		return {
			enabled: values[ENABLED_KEY] === true,
			token: String(values[TOKEN_KEY] || '').trim(),
			defaultCid: normalizeCid(values[TARGET_CID_KEY], '0'),
		}
	}

	function normalizeJobs(value) {
		if (Array.isArray(value)) {
			return Object.fromEntries(value
				.filter(item => item && typeof item === 'object' && String(item.jobId || '').trim())
				.map(item => [String(item.jobId).trim(), { ...item, jobId: String(item.jobId).trim() }]))
		}
		if (!value || typeof value !== 'object') return {}
		const jobs = {}
		for (const [jobId, item] of Object.entries(value)) {
			if (!item || typeof item !== 'object') continue
			const normalized = String(item.jobId || jobId || '').trim()
			if (normalized) jobs[normalized] = { ...item, jobId: normalized }
		}
		return jobs
	}

	async function readJobs() {
		const values = await getStorage(JOBS_KEY)
		return normalizeJobs(values[JOBS_KEY])
	}

	async function writeJobs(jobs, protectedJobIds = []) {
		const protectedIds = new Set(protectedJobIds || [])
		const entries = Object.entries(normalizeJobs(jobs))
		if (entries.length > MAX_JOBS) {
			const active = entries.filter(([jobId, item]) => !TERMINAL_JOB_STATES.has(item.status) || protectedIds.has(jobId))
			const historical = entries
				.filter(([jobId, item]) => TERMINAL_JOB_STATES.has(item.status) && !protectedIds.has(jobId))
				.sort(([, left], [, right]) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))
			const keepHistorical = Math.max(0, MAX_JOBS - active.length)
			jobs = Object.fromEntries([
				...active,
				...(keepHistorical > 0 ? historical.slice(-keepHistorical) : []),
			])
		}
		await setStorage({ [JOBS_KEY]: jobs })
		return jobs
	}

	function normalizeActions(value) {
		if (Array.isArray(value)) {
			return Object.fromEntries(value
				.filter(item => item && typeof item === 'object' && ACTION_ID_PATTERN.test(String(item.actionId || '').trim()))
				.map(item => [String(item.actionId).trim(), { ...item, actionId: String(item.actionId).trim() }]))
		}
		if (!value || typeof value !== 'object') return {}
		const actions = {}
		for (const [actionId, item] of Object.entries(value)) {
			if (!item || typeof item !== 'object') continue
			const normalized = String(item.actionId || actionId || '').trim()
			if (ACTION_ID_PATTERN.test(normalized)) actions[normalized] = { ...item, actionId: normalized }
		}
		return actions
	}

	async function readActions() {
		const values = await getStorage(ACTIONS_KEY)
		return normalizeActions(values[ACTIONS_KEY])
	}

	async function writeActions(actions, protectedActionIds = []) {
		const protectedIds = new Set(protectedActionIds || [])
		const entries = Object.entries(normalizeActions(actions))
		if (entries.length > MAX_JOBS) {
			const active = entries.filter(([actionId, item]) => !TERMINAL_ACTION_STATES.has(item.status) || protectedIds.has(actionId))
			const historical = entries
				.filter(([actionId, item]) => TERMINAL_ACTION_STATES.has(item.status) && !protectedIds.has(actionId))
				.sort(([, left], [, right]) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))
			const keepHistorical = Math.max(0, MAX_JOBS - active.length)
			actions = Object.fromEntries([
				...active,
				...(keepHistorical > 0 ? historical.slice(-keepHistorical) : []),
			])
		}
		await setStorage({ [ACTIONS_KEY]: actions })
		return actions
	}

	async function readOutbox() {
		const values = await getStorage(OUTBOX_KEY)
		if (!Array.isArray(values[OUTBOX_KEY])) return []
		return values[OUTBOX_KEY].filter(item => item && typeof item === 'object' && String(item.eventId || '').trim())
	}

	async function readActionOutbox() {
		const values = await getStorage(ACTION_OUTBOX_KEY)
		if (!Array.isArray(values[ACTION_OUTBOX_KEY])) return []
		return values[ACTION_OUTBOX_KEY].filter(item => item && typeof item === 'object' && String(item.eventId || '').trim())
	}

	async function writeActionOutbox(outbox) {
		const list = Array.isArray(outbox) ? outbox : []
		const ordered = list.slice().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
		// Action acknowledgements are all durable terminal transitions. Keep them
		// until the Bridge accepts them instead of dropping old receipts at a
		// soft capacity boundary.
		await setStorage({ [ACTION_OUTBOX_KEY]: ordered })
		return ordered
	}

	async function writeOutbox(outbox) {
		const list = Array.isArray(outbox) ? outbox : []
		const ordered = list.slice().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
		const latestProgress = new Map()
		const durable = []
		for (const item of ordered) {
			if (item?.payload?.state === 'progress') latestProgress.set(String(item.jobId || ''), item)
			else durable.push(item)
		}
		const progress = [...latestProgress.values()]
		const bounded = [...durable, ...progress]
			.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
		// Accepted, terminal and uncertain events are durable.  If they alone
		// exceed the soft bound, retain them rather than silently losing a state
		// transition that the bridge must see.
		if (bounded.length > MAX_OUTBOX) {
			const durableCount = durable.length
			const keepProgress = Math.max(0, MAX_OUTBOX - durableCount)
			const keptProgress = keepProgress > 0 ? progress.slice(-keepProgress) : []
			bounded.length = 0
			bounded.push(...durable, ...keptProgress)
			bounded.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
		}
		await setStorage({ [OUTBOX_KEY]: bounded })
		return bounded
	}

	async function updateJob(jobId, patch = {}) {
		return serial(async () => {
			const jobs = await readJobs()
			const current = jobs[jobId] || { jobId, createdAt: now() }
			jobs[jobId] = { ...current, ...patch, jobId, updatedAt: now() }
			await writeJobs(jobs)
			return jobs[jobId]
		})
	}

	function extractResponseBody(response, token) {
		if (!response) return Promise.reject(bridgeError('bridge 未返回响应', 'BRIDGE_NO_RESPONSE', { uncertain: true }))
		if (response.redirected) return Promise.reject(bridgeError('bridge 重定向被拒绝', 'BRIDGE_REDIRECT', { uncertain: true }))
		const parse = text => {
			if (text === undefined || text === null || text === '') return null
			try { return JSON.parse(text) } catch (error) { return text }
		}
		const bodyPromise = typeof response.text === 'function'
			? response.text().then(parse)
			: typeof response.json === 'function' ? response.json() : Promise.resolve(null)
		return bodyPromise.then(body => {
			const successful = response.ok === undefined
				? Number(response.status || 0) >= 200 && Number(response.status || 0) < 300
				: response.ok
			if (!successful) {
				const error = bridgeError(`bridge 请求失败（HTTP ${response.status || 0}）`, `HTTP_${response.status || 0}`, {
					status: response.status,
					uncertain: Number(response.status) >= 500 || Number(response.status) === 408,
				})
				error.responseBody = scrubWithToken(typeof body === 'string' ? body : '', token)
				return Promise.reject(error)
			}
			// Event handlers may legitimately answer 204; callers that require a
			// claim object validate its fields separately below.
			if (body === null) return {}
			if (typeof body === 'object') return body
			return Promise.reject(bridgeError('bridge 返回格式无效', 'BRIDGE_INVALID_RESPONSE', { uncertain: true }))
		})
	}

	function bridgeUrl(path) {
		const rawPath = String(path || '')
		const jobEventPath = /^\/v1\/jobs\/[^\/?#]+\/events$/
		const actionEventPath = /^\/v1\/actions\/[^\/?#]+\/events$/
		const directoryRegistryPath = '/v1/runtime/directories'
		if (rawPath !== '/v1/jobs/claim' && rawPath !== '/v1/actions/claim' && rawPath !== directoryRegistryPath && !jobEventPath.test(rawPath) && !actionEventPath.test(rawPath)) {
			throw bridgeError('bridge 路径无效', 'BRIDGE_INVALID_PATH')
		}
		let url
		try { url = new URL(rawPath, BASE_URL) } catch (error) { throw bridgeError('bridge 地址无效', 'BRIDGE_INVALID_URL') }
		if (url.origin !== ORIGIN || url.protocol !== 'http:' || url.username || url.password) {
			throw bridgeError('bridge 地址不在受支持的 loopback 范围内', 'BRIDGE_UNSAFE_URL')
		}
		return url.toString()
	}

	async function requestJson(path, body, token, method = 'POST') {
		const auth = String(token || '').trim()
		if (!auth) throw bridgeError('未配置 bridge Bearer token', 'BRIDGE_TOKEN_MISSING')
		const url = bridgeUrl(path)
		const requestMethod = String(method || 'POST').trim().toUpperCase()
		if (!['GET', 'POST', 'PUT'].includes(requestMethod)) throw bridgeError('bridge 请求方法无效', 'BRIDGE_INVALID_METHOD')
		const headers = {
			Accept: 'application/json',
			Authorization: `Bearer ${auth}`,
		}
		if (requestMethod !== 'GET' && body !== undefined && body !== null) headers['Content-Type'] = 'application/json'
		const requestOptions = {
			method: requestMethod,
			headers,
			credentials: 'omit',
			redirect: 'error',
			referrerPolicy: 'no-referrer',
			cache: 'no-store',
			...(requestMethod !== 'GET' && body !== undefined && body !== null ? { body: JSON.stringify(body) } : {}),
		}
		let response
		let controller = null
		let timeoutId = null
		try {
			const Controller = global.AbortController || (typeof AbortController !== 'undefined' ? AbortController : null)
			if (Controller) {
				controller = new Controller()
				timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
			}
		} catch (error) {
			controller = null
		}
		try {
			response = await fetch(url, { ...requestOptions, ...(controller ? { signal: controller.signal } : {}) })
			// Keep the abort timer alive through response.text()/response.json().
			// Fetch resolves as soon as headers arrive, while a broken local bridge
			// can leave the body stream pending indefinitely.
			return await extractResponseBody(response, auth)
		} catch (error) {
			// Preserve errors that already carry an intentional bridge/HTTP code;
			// only an unclassified transport or body-stream failure is normalized
			// here.  This keeps explicit 4xx rejection evidence available to callers.
			const code = String(error?.code || '').toUpperCase()
			if (code.startsWith('BRIDGE_') || /^HTTP_\d+$/.test(code)) throw error
			if (String(error?.name || '').toLowerCase() === 'aborterror') {
				throw bridgeError('bridge 请求超时，提交结果可能未知', 'BRIDGE_TIMEOUT', { uncertain: true })
			}
			throw bridgeError('bridge 网络请求失败，提交结果可能未知', 'BRIDGE_NETWORK', { uncertain: true })
		} finally {
			if (timeoutId !== null) clearTimeout(timeoutId)
		}
	}

	async function hasPermission() {
		if (!chrome.permissions?.contains) return true
		try {
			const result = await chrome.permissions.contains({ origins: [HOST_PERMISSION] })
			return result !== false
		} catch (error) {
			return false
		}
	}

	async function workerId() {
		if (workerIdPromise) return workerIdPromise
		workerIdPromise = (async () => {
			const workerKey = 'push115_bridge_worker_id'
			const values = await getStorage(workerKey)
			const saved = String(values[workerKey] || '').trim()
			const runtimeId = String(chrome.runtime?.id || '').trim()
			// runtime.id identifies the extension package, not a Chrome profile.
			// Keep a random per-profile identity in local storage so two profiles
			// cannot claim the same bridge lease.  Replace the pre-bridge fallback
			// value if an older build stored runtime.id directly.
			if (saved && (!runtimeId || saved !== runtimeId)) return saved
			const generated = `${runtimeId || 'worker'}-${makeId('worker')}`
			await setStorage({ [workerKey]: generated })
			return generated
		})()
		return workerIdPromise
	}

	function normalizeActionId(value, field = 'actionId') {
		const id = String(value || '').trim()
		if (!ACTION_ID_PATTERN.test(id)) throw bridgeError(`bridge action ${field} 无效`, 'BRIDGE_INVALID_ACTION', { uncertain: true })
		return id
	}

	function normalizeActionClaim(result) {
		if (!result || result.schema !== 1) throw bridgeError('bridge action claim schema 无效', 'BRIDGE_INVALID_ACTION', { uncertain: true })
		const raw = result.action
		if (raw === undefined || raw === null) return null
		if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.schema !== undefined && raw.schema !== 1)) throw bridgeError('bridge action 响应格式无效', 'BRIDGE_INVALID_ACTION', { uncertain: true })
		const actionId = normalizeActionId(raw.actionId)
		const leaseId = normalizeActionId(raw.leaseId, 'leaseId')
		const job = raw.job
		const validationErrors = []
		const validId = value => ACTION_ID_PATTERN.test(String(value || '').trim())
		const rawJobId = String(raw.jobId || '').trim()
		const nestedJobId = job && typeof job === 'object' && !Array.isArray(job) ? String(job.jobId || '').trim() : ''
		const jobId = validId(rawJobId) ? rawJobId : validId(nestedJobId) ? nestedJobId : ''
		if (!validId(rawJobId) || (nestedJobId && nestedJobId !== rawJobId)) validationErrors.push({ code: 'ACTION_JOB_INVALID', message: 'action jobId 与嵌套 job 不一致或无效' })
		const actionTypeValue = String(raw.actionType || '').trim().toLowerCase()
		const typeValue = String(raw.type || '').trim().toLowerCase()
		const actionType = actionTypeValue || typeValue
		if (actionTypeValue && typeValue && actionTypeValue !== typeValue) validationErrors.push({ code: 'ACTION_TYPE_MISMATCH', message: 'actionType 与 type 不一致' })
		if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(actionType)) validationErrors.push({ code: 'ACTION_TYPE_INVALID', message: 'bridge action 类型无效' })
		let taskId = ''
		if (job && typeof job === 'object' && !Array.isArray(job)) {
			if (job.taskId !== undefined && job.taskId !== null && String(job.taskId).trim() !== '') {
				if (validId(job.taskId)) taskId = String(job.taskId).trim()
				else validationErrors.push({ code: 'ACTION_TASK_INVALID', message: 'bridge action taskId 无效' })
			}
		} else {
			validationErrors.push({ code: 'ACTION_JOB_MISSING', message: 'bridge action 缺少 job' })
		}
		return {
			actionId,
			jobId,
			leaseId,
			actionType,
			taskId,
			jobStatus: normalizeClaimStatus(job?.status),
			validationError: validationErrors[0] || null,
			status: 'claimed',
			createdAt: now(),
			updatedAt: now(),
		}
	}

	async function updateAction(actionId, patch = {}) {
		return serial(async () => {
			const actions = await readActions()
			const current = actions[actionId]
			if (!current) return null
			actions[actionId] = { ...current, ...patch, actionId, updatedAt: now() }
			await writeActions(actions)
			return actions[actionId]
		})
	}

	async function persistActionClaim(action) {
		return serial(async () => {
			const actions = await readActions()
			const current = actions[action.actionId]
			if (current && TERMINAL_ACTION_STATES.has(current.status)) return current
			actions[action.actionId] = {
			...(current || {}),
			...action,
			status: current?.status === 'running' ? 'running' : (current?.status || action.status || 'claimed'),
			createdAt: current?.createdAt || action.createdAt || now(),
			updatedAt: now(),
			}
			await writeActions(actions)
			return actions[action.actionId]
		})
	}

	function safeActionResult(value) {
		if (value === undefined || value === null) return undefined
		if (typeof value === 'string') return { message: scrub(value, 1024) }
		if (!value || typeof value !== 'object' || Array.isArray(value)) return { message: scrub(value, 1024) }
		const result = {}
		for (const keyName of ['taskId', 'status', 'scope', 'message', 'bridgeJobStatus']) {
			if (value[keyName] === undefined || value[keyName] === null) continue
			if (typeof value[keyName] !== 'string' && typeof value[keyName] !== 'number') continue
			result[keyName] = scrub(value[keyName], keyName === 'message' ? 1024 : 256)
		}
		if (typeof value.localTaskFound === 'boolean') result.localTaskFound = value.localTaskFound
		return result
	}

	function actionEventFingerprint(state, details = {}) {
		return JSON.stringify([
			state,
			safeActionResult(details.result),
			String(details.errorCode || ''),
			String(details.errorMessage || ''),
		])
	}

	function actionEventPayload(action, state, details = {}, eventId) {
		const payload = {
			schema: 1,
			leaseId: String(action.leaseId || ''),
			eventId,
			state,
		}
		const result = safeActionResult(details.result)
		if (result !== undefined) payload.result = result
		const error = scrub(details.errorCode, 80)
		const message = scrub(details.errorMessage, 1024)
		if (error) payload.errorCode = error
		if (message) payload.errorMessage = message
		return payload
	}

	async function enqueueActionEvent(actionId, state, details = {}, actionPatch = {}) {
		if (!TERMINAL_ACTION_STATES.has(state)) throw bridgeError('bridge action 状态无效', 'BRIDGE_INVALID_ACTION')
		return serial(async () => {
			const actions = await readActions()
			const current = actions[actionId]
			if (!current) return { queued: false, missing: true }
			const fingerprint = actionEventFingerprint(state, details)
			if (current.lastEventFingerprint === fingerprint) return { queued: false, duplicate: true }
			const outbox = await readActionOutbox()
			const pending = outbox.find(item => item.actionId === actionId
				&& String(item.payload?.leaseId || '') === String(current.leaseId || '')
				&& actionEventFingerprint(item.payload?.state, {
					result: item.payload?.result,
					errorCode: item.payload?.errorCode,
					errorMessage: item.payload?.errorMessage,
				}) === fingerprint)
			const eventId = pending?.eventId || makeId('action-event')
			const payload = pending?.payload || actionEventPayload(current, state, details, eventId)
			if (!pending) outbox.push({
				eventId,
				actionId,
				jobId: current.jobId,
				payload,
				createdAt: now(),
				attempts: 0,
				nextAttemptAt: 0,
			})
			actions[actionId] = {
				...current,
				...actionPatch,
				status: actionPatch.status || state,
				lastEventFingerprint: fingerprint,
				updatedAt: now(),
			}
			// Keep the receipt and stable event ID in one storage mutation so a
			// service-worker restart can replay the same acknowledgement.
			await setStorage({ [ACTIONS_KEY]: actions, [ACTION_OUTBOX_KEY]: outbox })
			return { queued: true, event: outbox.find(item => item.eventId === eventId) }
		})
	}

	async function removeActionOutboxEvent(eventId) {
		return serial(async () => {
			const outbox = await readActionOutbox()
			await writeActionOutbox(outbox.filter(item => item.eventId !== eventId))
		})
	}

	async function markActionOutboxAttempt(eventId, error, token = '') {
		return serial(async () => {
			const outbox = await readActionOutbox()
			for (const item of outbox) {
				if (item.eventId !== eventId) continue
				item.attempts = Number(item.attempts || 0) + 1
				item.nextAttemptAt = 0
				item.lastErrorCode = errorCode(error, 'BRIDGE_ACTION_EVENT_ERROR')
				item.lastError = scrubWithToken(error?.message, token)
			}
			await writeActionOutbox(outbox)
		})
	}

	async function flushActionOutbox(config = null) {
		const bridgeConfig = config || await readConfig()
		if (!bridgeConfig.token) return false
		const outbox = await readActionOutbox()
		if (outbox.length === 0) return true
		for (const item of outbox.slice().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))) {
			if (Number(item.nextAttemptAt || 0) > now()) continue
			try {
				await requestJson(`/v1/actions/${encodeURIComponent(String(item.actionId || ''))}/events`, item.payload, bridgeConfig.token)
				await removeActionOutboxEvent(item.eventId)
			} catch (error) {
				await markActionOutboxAttempt(item.eventId, error, bridgeConfig.token)
				return false
			}
		}
		return (await readActionOutbox()).length === 0
	}

	async function markBridgeJobCancelled(action) {
		const jobs = await readJobs()
		const current = jobs[action.jobId]
		if (current?.status === 'cancelled') return current
		return updateJob(action.jobId, {
			status: 'cancelled',
			taskId: action.taskId || current?.taskId || '',
			remoteId: current?.remoteId || '',
		})
	}

	async function executeCancelTaskAction(action) {
		const tasks = await readTasks()
		let candidates = action.taskId
			? tasks.filter(item => taskId(item) === action.taskId)
			: tasks.filter(item => taskBridgeJobId(item) === action.jobId)
		// A worker restart can retain the Bridge job receipt even when the local
		// task was written in a separate storage turn. Use that receipt only as a
		// task-id mapping; never fall back to a remote hash or a directory scan.
		if (!action.taskId && candidates.length === 0) {
			const jobs = await readJobs()
			const mappedTaskId = taskId(jobs[action.jobId])
			if (mappedTaskId) candidates = tasks.filter(item => taskId(item) === mappedTaskId)
		}
		if (candidates.length > 1) {
			return { state: 'failed', errorCode: 'TASK_AMBIGUOUS', errorMessage: 'action jobId 对应多个本地任务，未执行取消' }
		}
		const task = candidates[0] || null
		if (task) {
			const taskJobId = taskBridgeJobId(task)
			if (taskJobId && taskJobId !== action.jobId) {
				return {
					state: 'failed',
					errorCode: 'TASK_JOB_MISMATCH',
					errorMessage: 'action jobId 与本地任务不匹配',
				}
			}
		}
		const serverTerminal = TERMINAL_JOB_STATES.has(action.jobStatus)
			&& action.jobStatus !== 'claimed'
		if (!task) {
			if (serverTerminal) {
				return {
					state: 'noop',
					result: {
						taskId: action.taskId,
						scope: 'local',
						status: action.jobStatus,
						bridgeJobStatus: action.jobStatus,
						localTaskFound: false,
						message: '本地任务不存在，且 Bridge 任务已结束',
					},
				}
			}
			await markBridgeJobCancelled(action)
			return {
				state: 'applied',
				result: {
					taskId: action.taskId,
					scope: 'local',
					status: 'cancelled',
					bridgeJobStatus: 'cancelled',
					localTaskFound: false,
					message: '本地任务不存在，已停止 Bridge 本地跟踪；115 云端离线任务未取消',
				},
			}
		}
		if (typeof background.TaskStore?.cancel !== 'function') {
			return { state: 'failed', errorCode: 'TASK_CANCEL_UNAVAILABLE', errorMessage: '本地任务取消入口不可用' }
		}
		const active = ['waiting', 'processing'].includes(task.status)
		if (active) {
			const cancelled = await background.TaskStore.cancel(taskId(task), { source: 'bridge' })
			if (!cancelled || taskId(cancelled) !== taskId(task) || cancelled.status !== 'cancelled') {
				return { state: 'uncertain', errorCode: 'TASK_CANCEL_UNCERTAIN', errorMessage: '本地任务取消结果无法确认' }
			}
		}
		if (serverTerminal) {
			return {
				state: 'noop',
				result: {
					taskId: taskId(task),
					scope: 'local',
					status: String(task.status || 'unknown'),
					bridgeJobStatus: action.jobStatus,
					localTaskFound: true,
					message: '本地任务已结束，Bridge 任务也已结束',
				},
			}
		}
		await markBridgeJobCancelled(action)
		return {
			state: 'applied',
			result: {
				taskId: taskId(task),
				scope: 'local',
				status: 'cancelled',
				bridgeJobStatus: 'cancelled',
				localTaskFound: true,
				message: active
					? '已在本地停止后处理与监控；115 云端离线任务未取消'
					: '本地任务已无活动后处理，已停止 Bridge 本地跟踪；115 云端离线任务未取消',
			},
		}
	}

	async function executeClaimedAction(action) {
		if (!action || TERMINAL_ACTION_STATES.has(action.status)) return { skipped: true }
		await updateAction(action.actionId, { status: 'running' })
		try {
			if (action.validationError) {
				return enqueueActionEvent(action.actionId, 'failed', {
					errorCode: action.validationError.code,
					errorMessage: action.validationError.message,
				}, { status: 'failed' })
			}
			if (!ACTION_TYPES.has(action.actionType)) {
				return enqueueActionEvent(action.actionId, 'failed', {
					errorCode: 'UNSUPPORTED_ACTION',
					errorMessage: '不支持的 Bridge action 类型',
				}, { status: 'failed' })
			}
			const outcome = await executeCancelTaskAction(action)
			return enqueueActionEvent(action.actionId, outcome.state, outcome, { status: outcome.state })
		} catch (error) {
			return enqueueActionEvent(action.actionId, 'uncertain', {
				errorCode: 'ACTION_UNCERTAIN',
				errorMessage: '本地 action 执行结果无法确认',
			}, { status: 'uncertain' })
		}
	}

	function safeIntent(rawIntent, jobId, defaultCid) {
		const input = rawIntent?.intent && typeof rawIntent.intent === 'object' ? rawIntent.intent : rawIntent
		const source = input && typeof input === 'object' && !Array.isArray(input) ? input : null
		const invalid = () => { throw bridgeError('bridge intent 无效', 'BRIDGE_INVALID_INTENT') }
		if (!source) return invalid()

		const claimJobId = String(jobId || '').trim()
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claimJobId)) return invalid()

		if (typeof source.sourceSite !== 'string' || typeof source.mediaType !== 'string' || typeof source.processorProfile !== 'string') return invalid()
		const sourceSiteRaw = source.sourceSite.trim()
		const mediaType = source.mediaType.trim()
		const processorProfile = source.processorProfile.trim()
		if (!SAFE_SOURCE_SITE.test(sourceSiteRaw) || sourceSiteRaw !== sourceSiteRaw.toLowerCase()) return invalid()
		if (!INTENT_MEDIA_TYPES.has(mediaType) || !INTENT_PROCESSOR_PROFILES.has(processorProfile)) return invalid()

		if (source.url !== undefined && source.url !== null && typeof source.url !== 'string') return invalid()
		if (source.magnet !== undefined && source.magnet !== null && typeof source.magnet !== 'string') return invalid()
		const urlValue = source.url === undefined || source.url === null ? '' : source.url.trim()
		const magnetValue = source.magnet === undefined || source.magnet === null ? '' : source.magnet.trim()
		if (urlValue && magnetValue && urlValue !== magnetValue) return invalid()
		const url = urlValue || magnetValue
		const intentApi = global.Push115.DownloadIntent
		if (!intentApi?.parseDownloadLink || !intentApi?.create) return invalid()
		const parsedLink = intentApi.parseDownloadLink(url)
		if (!parsedLink) return invalid()

		const rawCid = source.savePathCid
		const cidMissing = rawCid === undefined || rawCid === null || String(rawCid).trim() === ''
		const savePathCid = cidMissing
			? normalizeCid(defaultCid, '0')
			: String(rawCid).trim()
		if (!/^\d{1,64}$/.test(savePathCid)) return invalid()
		if (url.length > 8192) return invalid()

		// DownloadIntent intentionally keeps a broad legacy Magnet parser for
		// direct extension submissions. The Bridge boundary follows the server
		// contract and accepts only standard BTIH magnets, plus a strict ED2K wire shape.
		let strictEd2k = null
		const legacyBtih = intentApi.extractBtih?.(url) || ''
		const parsedBtih = /^(?:[A-Za-z2-7]{32}|[A-Fa-f0-9]{40})$/.test(legacyBtih)
			? legacyBtih.toLowerCase() : ''
		if (parsedLink.linkType === 'magnet' && !parsedBtih) return invalid()
		if (parsedLink.linkType === 'ed2k') {
			const match = url.match(/^ed2k:\/\/\|file\|([^|]*)\|([0-9]+)\|([a-f0-9]{32})\|\/$/i)
			if (!match) return invalid()
			let fileName
			try { fileName = decodeURIComponent(match[1]).trim() } catch (error) { return invalid() }
			if (!fileName || fileName.length > 1024 || fileName.includes('|') || /[\u0000-\u001f\u007f]/.test(fileName)) return invalid()
			try {
				const size = BigInt(match[2])
				if (size < 0n || size > 9223372036854775807n) return invalid()
				strictEd2k = {
					fileName,
					size: size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size.toString(),
					sizeText: size.toString(),
					hash: match[3].toLowerCase(),
				}
			} catch (error) { return invalid() }
		}

		const copyText = (value, limit) => {
			if (value === undefined || value === null || value === '') return ''
			if (typeof value !== 'string' && typeof value !== 'number') return invalid()
			const text = String(value).trim()
			if (text.length > limit) return invalid()
			return text
		}
		const copyNumber = (value, keyName) => {
			if (value === undefined || value === null || value === '') return undefined
			const text = String(value)
			if (/\s/.test(text)) return invalid()
			if (!/^\d+$/.test(text) || text.length > 24) return invalid()
			let number
			try { number = BigInt(text) } catch (error) { return invalid() }
			if (number > MAX_INT64) return invalid()
			const canonical = number.toString()
			return keyName === 'expectedSize' && number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(canonical) : canonical
		}
		const copyHash = (value, keyName) => {
			const text = copyText(value, 128).toLowerCase()
			if (!text) return ''
			const pattern = keyName === 'btih' ? /^(?:[a-z2-7]{32}|[a-f0-9]{40})$/ : /^[a-f0-9]{32,128}$/
			if (!pattern.test(text)) return invalid()
			return text
		}

		const rawMetadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
			? source.metadata : {}
		const metadata = {}
		for (const name of BRIDGE_METADATA_KEYS) {
			if (!Object.prototype.hasOwnProperty.call(rawMetadata, name)) continue
			const value = rawMetadata[name]
			if (BRIDGE_METADATA_BOOLEAN_KEYS.has(name)) {
				if (typeof value !== 'boolean') return invalid()
				metadata[name] = value
				continue
			}
			if (BRIDGE_METADATA_NUMBER_KEYS.has(name)) {
				metadata[name] = copyNumber(value, name)
				continue
			}
			if (!BRIDGE_METADATA_TEXT_KEYS.has(name)) continue
			if (name === 'btih' || name === 'ed2kHash' || name === 'expectedHash') metadata[name] = copyHash(value, name)
			else metadata[name] = copyText(value, ['fileName', 'ed2kFileName', 'expectedName'].includes(name) ? 1024 : 2048)
		}
		if (metadata.linkType && metadata.linkType !== parsedLink.linkType) return invalid()
		if (metadata.btih && parsedBtih && metadata.btih !== parsedBtih) return invalid()

		const fieldText = (name, limit) => {
			if (source[name] === undefined || source[name] === null || source[name] === '') return undefined
			return copyText(source[name], limit)
		}
		const rawExpectedSize = copyNumber(source.expectedSize, 'expectedSize')
		const rawExpectedHash = source.expectedHash === undefined || source.expectedHash === null || source.expectedHash === ''
			? undefined : copyHash(source.expectedHash, 'expectedHash')
		if (source.linkType !== undefined && source.linkType !== null && String(source.linkType).trim() !== parsedLink.linkType) return invalid()

		const candidate = {
			sourceSite: sourceSiteRaw,
			mediaType,
			processorProfile,
			url,
			jobId: claimJobId,
			savePathCid,
			monitorDownload: true,
			metadata,
		}
		for (const [name, limit] of [['title', 512], ['code', 64], ['expectedName', 1024]]) {
			const value = fieldText(name, limit)
			if (value !== undefined) candidate[name] = value
		}
		if (rawExpectedSize !== undefined) candidate.expectedSize = rawExpectedSize
		if (rawExpectedHash !== undefined) candidate.expectedHash = rawExpectedHash
		if (strictEd2k) {
			if (candidate.expectedName !== undefined && candidate.expectedName !== strictEd2k.fileName) return invalid()
			if (candidate.expectedSize !== undefined) {
				try {
					if (BigInt(String(candidate.expectedSize)) !== BigInt(strictEd2k.sizeText)) return invalid()
				} catch (error) { return invalid() }
			}
			if (candidate.expectedHash !== undefined && candidate.expectedHash !== strictEd2k.hash) return invalid()
			candidate.expectedName = strictEd2k.fileName
			candidate.expectedSize = strictEd2k.size
			candidate.expectedHash = strictEd2k.hash
		}

		let intent
		try {
			intent = intentApi.create(candidate)
		} catch (error) {
			return invalid()
		}
		if (!intent || intent.sourceSite !== sourceSiteRaw || intent.mediaType !== mediaType || intent.processorProfile !== processorProfile
			|| intent.linkType !== parsedLink.linkType || intent.savePathCid !== savePathCid) return invalid()
		const boundedCanonicalText = (value, limit) => typeof value === 'string' && value.length <= limit
		const sourceTitleProvided = source.title !== undefined && source.title !== null && String(source.title).trim() !== ''
		if (typeof intent.title !== 'string') return invalid()
		if (intent.title.length > 512) {
			if (sourceTitleProvided) return invalid()
			intent.title = String(intent.expectedName || '').slice(0, 512)
		}
		if (!boundedCanonicalText(intent.title, 512)
			|| !boundedCanonicalText(intent.code, 64)
			|| !boundedCanonicalText(intent.expectedName, 1024)
			|| typeof intent.expectedHash !== 'string'
			|| intent.expectedHash.length > 128
			|| (intent.expectedHash !== '' && !/^[a-f0-9]{32,128}$/.test(intent.expectedHash))) return invalid()
		if (intent.expectedSize !== undefined && intent.expectedSize !== null && intent.expectedSize !== '') {
			const sizeText = String(intent.expectedSize)
			if (!/^\d+$/.test(sizeText)) return invalid()
			try {
				const size = BigInt(sizeText)
				if (size > MAX_INT64) return invalid()
				if (size <= BigInt(Number.MAX_SAFE_INTEGER)) {
					if (typeof intent.expectedSize !== 'number' || !Number.isSafeInteger(intent.expectedSize) || intent.expectedSize !== Number(size)) return invalid()
				} else if (typeof intent.expectedSize !== 'string' || intent.expectedSize !== size.toString()) return invalid()
			} catch (error) { return invalid() }
		}
		if (strictEd2k) {
			try {
				if (intent.expectedName !== strictEd2k.fileName
					|| BigInt(String(intent.expectedSize)) !== BigInt(strictEd2k.sizeText)
					|| intent.expectedHash !== strictEd2k.hash) return invalid()
			} catch (error) { return invalid() }
		}
		if (processorProfile === 'jav' && !intent.code) return invalid()

		// Rebuild metadata after canonicalization so untrusted bridge fields cannot
		// override the parser's link identity or the worker's submission guards.
		intent.metadata = {
			...intent.metadata,
			bridgeJobId: claimJobId,
			monitorDownload: true,
			linkType: intent.linkType,
			expectedName: intent.expectedName,
			expectedSize: intent.expectedSize,
			expectedHash: intent.expectedHash,
		}
		if (strictEd2k) {
			intent.metadata.fileName = strictEd2k.fileName
			intent.metadata.ed2kFileName = strictEd2k.fileName
			intent.metadata.ed2kSize = strictEd2k.size
			intent.metadata.ed2kHash = strictEd2k.hash
		}
		delete intent.metadata.skipSubmitted
		delete intent.metadata.animeTarget
		return intent
	}

	function taskBridgeJobId(task) {
		return String(
			task?.metadata?.bridgeJobId || task?.metadata?.bridge?.jobId || task?.bridgeJobId || task?.jobId || '',
		).trim()
	}

	function taskId(task) {
		return String(task?.taskId || task?.id || '').trim()
	}

	function remoteId(task) {
		return String(task?.remoteId || task?.info_hash || task?.infoHash || task?.hash || task?.task_id || task?.metadata?.btih || '').trim()
	}

	function findTask(tasks, job) {
		const list = Array.isArray(tasks) ? tasks : []
		const foundByJob = list.find(task => taskBridgeJobId(task) === String(job?.jobId || '').trim())
		if (foundByJob) return foundByJob
		if (job?.taskId) return list.find(task => taskId(task) === String(job.taskId).trim()) || null
		return null
	}

	function normalizeClaimStatus(value) {
		const candidate = String(value || '').trim().toLowerCase()
		return ['claimed', 'accepted', 'progress', 'completed', 'failed', 'uncertain', 'cancelled'].includes(candidate)
			? candidate : 'claimed'
	}

	function claimWasPreviouslySubmitted(status, recovered, attemptCount) {
		return recovered === true || Number(attemptCount) > 1
			|| ['accepted', 'progress', 'completed', 'failed', 'uncertain'].includes(status)
	}

	async function readTasks() {
		if (background.TaskStore?.read) {
			return background.TaskStore.read()
		}
		const values = await getStorage(TASKS_KEY)
		return Array.isArray(values[TASKS_KEY]) ? values[TASKS_KEY] : []
	}

	function safeTaskMessage(task) {
		return scrub(task?.message || task?.lastError || '')
	}

	function eventFingerprint(state, details = {}) {
		return JSON.stringify([
			state,
			String(details.taskId || ''),
			String(details.remoteId || ''),
			Number.isFinite(Number(details.percent)) ? Number(details.percent) : null,
			String(details.message || ''),
			String(details.errorCode || ''),
			String(details.errorMessage || ''),
		])
	}

	function eventPayload(job, state, details = {}, eventId) {
		const payload = {
			schema: 1,
			leaseId: String(job.leaseId || ''),
			eventId,
			state,
		}
		const id = String(details.taskId || job.taskId || '').trim()
		const remote = String(details.remoteId || job.remoteId || '').trim()
		if (id) payload.taskId = id
		if (remote) payload.remoteId = remote
		const percent = Number(details.percent)
		if (Number.isFinite(percent)) payload.percent = Math.max(0, Math.min(100, percent))
		const message = scrub(details.message)
		if (message) payload.message = message
		const code = scrub(details.errorCode, 80)
		const errorMessage = scrub(details.errorMessage)
		if (code) payload.errorCode = code
		if (errorMessage) payload.errorMessage = errorMessage
		return payload
	}

	async function enqueueEvent(jobId, state, details = {}, jobPatch = {}) {
		return serial(async () => {
			const jobs = await readJobs()
			const current = jobs[jobId]
			if (!current) return { queued: false, missing: true }
			const fingerprint = eventFingerprint(state, details)
			if (current.lastEventFingerprint === fingerprint) return { queued: false, duplicate: true }
			const eventId = makeId('event')
			const payload = eventPayload(current, state, details, eventId)
			const outbox = await readOutbox()
			if (!outbox.some(item => item.eventId === eventId)) {
				outbox.push({
					eventId,
					jobId,
					payload,
					createdAt: now(),
					attempts: 0,
					nextAttemptAt: 0,
				})
			}
			jobs[jobId] = {
				...current,
				...jobPatch,
				status: jobPatch.status || current.status,
				lastEventFingerprint: fingerprint,
				updatedAt: now(),
			}
			// One storage write keeps the event and its dedupe marker together as
			// far as chrome.storage.local permits.  A restart can therefore retry
			// the same eventId without submitting the 115 intent again.
			const ordered = outbox.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
			const latestProgress = new Map()
			const durable = []
			for (const item of ordered) {
				if (item?.payload?.state === 'progress') latestProgress.set(String(item.jobId || ''), item)
				else durable.push(item)
			}
			const progress = [...latestProgress.values()]
			let boundedOutbox = [...durable, ...progress]
			if (boundedOutbox.length > MAX_OUTBOX) {
				const keepProgress = Math.max(0, MAX_OUTBOX - durable.length)
				boundedOutbox = [...durable, ...(keepProgress > 0 ? progress.slice(-keepProgress) : [])]
				boundedOutbox.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
			}
			const pendingIds = boundedOutbox.map(item => String(item.jobId || '')).filter(Boolean)
			await writeJobs(jobs, pendingIds)
			await setStorage({ [OUTBOX_KEY]: boundedOutbox })
			return { queued: true, event: boundedOutbox.find(item => item.eventId === eventId) }
		})
	}

	async function removeOutboxEvent(eventId) {
		return serial(async () => {
			const outbox = await readOutbox()
			await writeOutbox(outbox.filter(item => item.eventId !== eventId))
		})
	}

	async function markOutboxAttempt(eventId, error) {
		return serial(async () => {
			const outbox = await readOutbox()
			const token = (await readConfig()).token
			for (const item of outbox) {
				if (item.eventId !== eventId) continue
				item.attempts = Number(item.attempts || 0) + 1
				item.nextAttemptAt = 0
				item.lastErrorCode = errorCode(error, 'BRIDGE_EVENT_ERROR')
				item.lastError = scrubWithToken(error?.message, token)
			}
			await writeOutbox(outbox)
		})
	}

	async function flushOutbox(config = null) {
		const bridgeConfig = config || await readConfig()
		if (!bridgeConfig.token) return false
		const outbox = await readOutbox()
		if (outbox.length === 0) return true
		for (const item of outbox.slice().sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))) {
			if (Number(item.nextAttemptAt || 0) > now()) continue
			try {
				await requestJson(`/v1/jobs/${encodeURIComponent(String(item.jobId || ''))}/events`, item.payload, bridgeConfig.token)
				await removeOutboxEvent(item.eventId)
			} catch (error) {
				await markOutboxAttempt(item.eventId, error)
				return false
			}
		}
		return (await readOutbox()).length === 0
	}

	function taskDetails(task, job) {
		const percent = Number(task?.percent)
		return {
			taskId: taskId(task) || job.taskId,
			remoteId: remoteId(task) || job.remoteId,
			percent: Number.isFinite(percent) ? percent : undefined,
			message: safeTaskMessage(task),
		}
	}

	async function reconcileJobTask(job, task) {
		if (task?.status === 'cancelled') {
			// Local cancellation is acknowledged through the action outbox. Never
			// turn that terminal local state into an ordinary job progress event.
			return { skipped: true, cancelled: true }
		}
		const details = taskDetails(task, job)
		const currentTaskId = details.taskId || ''
		const currentRemoteId = details.remoteId || ''
		const patch = {
			taskId: currentTaskId || job.taskId || '',
			remoteId: currentRemoteId || job.remoteId || '',
		}
		if (task.status === 'completed') {
			if (job.acceptedSent !== true) {
				await enqueueEvent(job.jobId, 'accepted', { taskId: currentTaskId, remoteId: currentRemoteId }, { ...patch, status: 'accepted', acceptedSent: true })
			}
			return enqueueEvent(job.jobId, 'completed', { ...details, percent: 100 }, { ...patch, status: 'completed' })
		}
		if (task.status === 'failed') {
			if (job.acceptedSent !== true) {
				await enqueueEvent(job.jobId, 'accepted', { taskId: currentTaskId, remoteId: currentRemoteId }, { ...patch, status: 'accepted', acceptedSent: true })
			}
			return enqueueEvent(job.jobId, 'failed', {
				...details,
				errorCode: task.errorCode || 'TASK_FAILED',
				errorMessage: task.lastError || task.message || '115 任务失败',
			}, { ...patch, status: 'failed' })
		}
		// `recorded` is deliberately treated as ordinary progress.  A bridge
		// job must never be reported completed merely because the local history
		// entry exists.
		let accepted = { queued: false }
		if (job.acceptedSent !== true) {
			accepted = await enqueueEvent(job.jobId, 'accepted', {
				taskId: currentTaskId,
				remoteId: currentRemoteId,
			}, { ...patch, status: 'accepted', acceptedSent: true })
		}
		const progressDetails = {
			...details,
			message: safeTaskMessage(task) || (task.status === 'recorded' ? '任务已记录，等待后台监控' : ''),
		}
		const progressFingerprint = eventFingerprint('progress', progressDetails)
		const latest = await readJobs()
		const refreshed = latest[job.jobId]
		const hasProgress = Boolean(progressDetails.message) || Number.isFinite(Number(progressDetails.percent))
		if (hasProgress && refreshed?.lastProgressFingerprint !== progressFingerprint) {
			return enqueueEvent(job.jobId, 'progress', progressDetails, {
				...patch,
				status: 'accepted',
				lastProgressFingerprint: progressFingerprint,
			})
		}
		return accepted
	}

	async function reconcileTasks() {
		const [jobs, tasks] = await Promise.all([readJobs(), readTasks()])
		for (const job of Object.values(jobs)) {
			if (!job?.jobId || TERMINAL_JOB_STATES.has(job.status)) continue
			const task = findTask(tasks, job)
			if (task) {
				if (task.status === 'cancelled') continue
				await reconcileJobTask(job, task)
				continue
			}
			if (job.status === 'submitting' || job.status === 'accepted') {
				await enqueueEvent(job.jobId, 'uncertain', {
					taskId: job.taskId,
					remoteId: job.remoteId,
					errorCode: 'TASK_NOT_FOUND',
					errorMessage: '本地提交记录不存在，无法安全确认结果',
					message: '提交结果不明确，已停止自动重试',
				}, { status: 'uncertain' })
			}
		}
	}

	function isExplicitRemoteRejectionError(error) {
		if (!error || typeof error !== 'object') return false
		if (error.remoteRejected === true || error.submissionRejected === true) return true
		if (error.remote?.rejected === true || error.remote?.accepted === false) return true
		const code = String(error.code || '').trim().toUpperCase()
		return [
			'REMOTE_REJECTED',
			'REMOTE_SUBMISSION_REJECTED',
			'OFFLINE_REJECTED',
			'OFFLINE_TASK_REJECTED',
			'115_REJECTED',
			'115_TASK_REJECTED',
			'115_SUBMISSION_REJECTED',
			'SUBMISSION_REJECTED',
		].includes(code)
	}

	function isUncertainSubmissionError(error, submissionStarted = false) {
		// Router.submitIntent performs the 115 request before it persists the
		// local task.  Any generic error after that call began may therefore mean
		// that 115 accepted the task and only local bookkeeping failed.
		if (submissionStarted && !isExplicitRemoteRejectionError(error)) return true
		if (isExplicitRemoteRejectionError(error)) return false
		if (error?.uncertain === true) return true
		if (Number(error?.status) >= 500 || Number(error?.status) === 408) return true
		const code = String(error?.code || '').toUpperCase()
		if (['BRIDGE_NETWORK', 'BRIDGE_NO_RESPONSE', 'BRIDGE_REDIRECT', 'BRIDGE_INVALID_RESPONSE', 'NETWORK_ERR', 'ERR_NETWORK', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return true
		const name = String(error?.name || '').toLowerCase()
		const message = String(error?.message || '').toLowerCase()
		return name === 'aborterror' || /network|fetch|timeout|timed out|connection reset|response unknown|结果不明确|上下文已失效/.test(message)
	}

	async function ensureTaskMonitoring(task) {
		if (!task || !background.TaskStore?.persist) return task
		const metadata = task.metadata && typeof task.metadata === 'object' ? task.metadata : {}
		const nextMetadata = { ...metadata, monitorDownload: true }
		const changed = metadata.monitorDownload !== true
		if (changed) task.metadata = nextMetadata
		if (changed && task.status === 'recorded') {
			task.status = 'waiting'
			task.message = '已登记后台监控'
			task.updatedAt = now()
			if (background.TaskStore.appendLog) background.TaskStore.appendLog(task, task.message)
		}
		if (changed) {
			await background.TaskStore.persist(task)
			if (background.TaskMonitor?.ensureAlarm) await background.TaskMonitor.ensureAlarm()
		}
		return task
	}

	async function submitClaimedJob(job, bridgeConfig) {
		const tasksBefore = await readTasks()
		const existing = findTask(tasksBefore, job)
		const serverStatus = normalizeClaimStatus(job.serverStatus || job.status)
		const previouslySubmitted = claimWasPreviouslySubmitted(serverStatus, job.recovered, job.attemptCount)
		if (existing) {
			if (existing.status === 'cancelled') {
				await updateJob(job.jobId, { status: 'cancelled', taskId: taskId(existing) || job.taskId || '' })
				return { skipped: true, cancelled: true }
			}
			// A recovered claim that the bridge already reports as progress or a
			// terminal state has already crossed the 115 submission boundary.  Mark
			// accepted as observed before reconciliation so we do not replay it.
			const reconciledJob = previouslySubmitted && serverStatus !== 'claimed'
				? { ...job, acceptedSent: job.acceptedSent === true || serverStatus !== 'claimed' }
				: job
			return reconcileJobTask(reconciledJob, existing)
		}
		if (job.status === 'submitting') {
			return enqueueEvent(job.jobId, 'uncertain', {
				taskId: job.taskId,
				remoteId: job.remoteId,
				errorCode: 'SUBMISSION_UNCERTAIN',
				errorMessage: '服务工作者重启后找不到提交任务',
				message: '提交结果不明确，已停止自动重试',
			}, { status: 'uncertain' })
		}
		if (previouslySubmitted || job.recovered === true) {
			return enqueueEvent(job.jobId, 'uncertain', {
				taskId: job.taskId,
				remoteId: job.remoteId,
				errorCode: 'SUBMISSION_UNCERTAIN',
				errorMessage: 'Bridge 恢复了已提交或过期租约，但本地没有可恢复的任务记录',
				message: '提交结果不明确，已停止自动重试',
			}, { status: 'uncertain' })
		}
		if (job.status !== 'claimed') return { skipped: true }
		const intent = safeIntent(job.intent, job.jobId, bridgeConfig.defaultCid)
		await updateJob(job.jobId, { status: 'submitting', intent })
		let submissionStarted = false
		try {
			if (!background.Router?.submitIntent) throw bridgeError('后台提交入口不可用', 'ROUTER_UNAVAILABLE')
			submissionStarted = true
			const result = await background.Router.submitIntent(intent)
			let task = result?.task || null
			if (!task) task = findTask(await readTasks(), { ...job, intent })
			if (!task) {
				return enqueueEvent(job.jobId, 'uncertain', {
					errorCode: 'SUBMISSION_NO_TASK',
					errorMessage: '提交响应未包含可恢复的本地任务',
					message: '提交结果不明确，已停止自动重试',
				}, { status: 'uncertain' })
			}
			await ensureTaskMonitoring(task)
			const details = taskDetails(task, job)
			return enqueueEvent(job.jobId, 'accepted', {
				taskId: details.taskId,
				remoteId: details.remoteId,
			}, {
				status: 'accepted',
				acceptedSent: true,
				taskId: details.taskId,
				remoteId: details.remoteId,
			})
		} catch (error) {
			const uncertain = isUncertainSubmissionError(error, submissionStarted)
			return enqueueEvent(job.jobId, uncertain ? 'uncertain' : 'failed', {
				taskId: job.taskId,
				remoteId: job.remoteId,
				errorCode: uncertain ? 'SUBMISSION_UNCERTAIN' : errorCode(error, 'SUBMISSION_FAILED'),
				errorMessage: uncertain ? '提交结果不明确，已停止自动重试' : scrub(error?.message || 'bridge 提交失败'),
				message: uncertain ? '提交结果不明确，已停止自动重试' : 'bridge 提交失败',
			}, { status: uncertain ? 'uncertain' : 'failed' })
		}
	}

	async function persistClaim(job) {
		return serial(async () => {
			const jobs = await readJobs()
			const current = jobs[job.jobId]
			if (current && TERMINAL_JOB_STATES.has(current.status)) return current
			jobs[job.jobId] = {
				...(current || {}),
				...job,
				// A claim response may be a recovery of an accepted/progress job.
				// Adopt that server state while retaining a more advanced local state
				// and never turn a recovered claim back into a fresh `claimed` job.
				status: current && !['claimed', 'submitting'].includes(current.status)
					? current.status : (job.status || 'claimed'),
				acceptedSent: current?.acceptedSent === true || job.acceptedSent === true,
				taskId: job.taskId || current?.taskId || '',
				remoteId: job.remoteId || current?.remoteId || '',
				createdAt: current?.createdAt || now(),
				updatedAt: now(),
			}
			await writeJobs(jobs)
			return jobs[job.jobId]
		})
	}

	function claimJobPayload(worker) {
		return { schema: 1, workerId: worker, leaseSeconds: LEASE_SECONDS }
	}

	async function claimJob(bridgeConfig) {
		const result = await requestJson('/v1/jobs/claim', claimJobPayload(await workerId()), bridgeConfig.token)
		const job = result?.job
		if (job === null || job === undefined) return null
		if (!job || typeof job !== 'object') throw bridgeError('bridge claim 响应格式无效', 'BRIDGE_INVALID_CLAIM', { uncertain: true })
		const jobId = String(job.jobId || '').trim()
		const leaseId = String(job.leaseId || '').trim()
		if (!jobId || !leaseId || !job.intent || typeof job.intent !== 'object') {
			throw bridgeError('bridge claim 缺少任务或租约字段', 'BRIDGE_INVALID_CLAIM', { uncertain: true })
		}
		const serverStatus = normalizeClaimStatus(job.status)
		const attemptCount = Number(job.attemptCount)
		const recovered = job.recovered === true
			|| (Number.isFinite(attemptCount) && attemptCount > 1)
			|| claimWasPreviouslySubmitted(serverStatus, false, attemptCount)
		const localStatus = serverStatus === 'progress' ? 'accepted' : serverStatus
		return {
			jobId,
			leaseId,
			intent: job.intent,
			status: localStatus,
			serverStatus,
			recovered,
			attemptCount: Number.isFinite(attemptCount) ? attemptCount : 0,
			taskId: String(job.taskId || '').trim(),
			remoteId: String(job.remoteId || '').trim(),
			acceptedSent: serverStatus !== 'claimed',
			createdAt: now(),
			updatedAt: now(),
		}
	}

	function claimActionPayload(worker) {
		return { schema: 1, workerId: worker, leaseSeconds: LEASE_SECONDS }
	}

	async function claimAction(bridgeConfig) {
		const result = await requestJson('/v1/actions/claim', claimActionPayload(await workerId()), bridgeConfig.token)
		return normalizeActionClaim(result)
	}

	async function processActions(bridgeConfig) {
		if (!await flushActionOutbox(bridgeConfig)) return { actionOutboxPending: true }
		const actions = await readActions()
		const pending = Object.values(actions).find(action => action?.status === 'claimed' || action?.status === 'running')
		if (pending) {
			await executeClaimedAction(pending)
			await flushActionOutbox(bridgeConfig)
			return { actionId: pending.actionId, actionResumed: true }
		}
		const claimed = await claimAction(bridgeConfig)
		if (!claimed) return { actionEmpty: true }
		const saved = await persistActionClaim(claimed)
		if (TERMINAL_ACTION_STATES.has(saved.status)) return { actionId: saved.actionId, actionDuplicate: true }
		await executeClaimedAction(saved)
		await flushActionOutbox(bridgeConfig)
		return { actionId: saved.actionId }
	}

	async function ensureAlarm() {
		const bridgeConfig = await readConfig()
		if (!chrome.alarms?.create) return false
		if (bridgeConfig.enabled) {
			const existing = chrome.alarms.get ? await chrome.alarms.get(ALARM_NAME) : null
			if (!existing) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES })
			return true
		}
		if (chrome.alarms.clear) await chrome.alarms.clear(ALARM_NAME)
		return false
	}

	async function syncDirectoryRegistry(index, bridgeConfig = null) {
		const config = bridgeConfig || await readConfig()
		if (!config.enabled || !config.token) return { disabled: true }
		if (!await hasPermission()) return { permission: false }
		const normalized = typeof background.DirectoryIndex?.normalizeIndex === 'function'
			? background.DirectoryIndex.normalizeIndex(index)
			: index
		const result = await requestJson('/v1/runtime/directories', {
			schema: 1,
			revision: Number(normalized?.revision) || 0,
			scannedAt: Number(normalized?.scannedAt) || 0,
			roots: Array.isArray(normalized?.roots) ? normalized.roots : ['0'],
			directories: Array.isArray(normalized?.directories) ? normalized.directories : [],
		}, config.token, 'PUT')
		if (!result || result.schema !== 1) throw bridgeError('目录 registry 响应格式无效', 'BRIDGE_INVALID_DIRECTORY_REGISTRY', { uncertain: true })
		return result
	}

	async function processPending() {
		if (running) return { skipped: true, running: true }
		running = true
		try {
			const bridgeConfig = await readConfig()
			if (!bridgeConfig.enabled || !bridgeConfig.token) return { disabled: true }
			if (!await hasPermission()) return { permission: false }
			const result = {}
			// Action receipts and job receipts use independent durable outboxes. A
			// failure in one poll must not prevent the other side from progressing.
			try {
				Object.assign(result, await processActions(bridgeConfig))
			} catch (error) {
				result.actionError = errorCode(error, 'BRIDGE_ACTION_POLL_FAILED')
			}
			try {
				await reconcileTasks()
				if (!await flushOutbox(bridgeConfig)) {
					result.outboxPending = true
				} else {
					const jobs = await readJobs()
					const claimed = Object.values(jobs).find(job => job?.status === 'claimed')
					if (claimed) {
						await submitClaimedJob(claimed, bridgeConfig)
						await flushOutbox(bridgeConfig)
						result.jobId = claimed.jobId
						result.resumed = true
					} else {
						const claimedJob = await claimJob(bridgeConfig)
						if (!claimedJob) result.empty = true
						else {
							claimedJob.intent = safeIntent(claimedJob.intent, claimedJob.jobId, bridgeConfig.defaultCid)
							const saved = await persistClaim(claimedJob)
							if (TERMINAL_JOB_STATES.has(saved.status)) {
								result.jobId = saved.jobId
								result.duplicate = true
							} else {
								await submitClaimedJob(saved, bridgeConfig)
								await flushOutbox(bridgeConfig)
								result.jobId = saved.jobId
							}
						}
					}
				}
			} catch (error) {
				// Network/bridge errors remain recoverable through the next alarm. Do
				// not log the token or response body.
				result.error = errorCode(error, 'BRIDGE_POLL_FAILED')
			}
			return result
		} finally {
			running = false
		}
	}

	async function syncConfig() {
		return ensureAlarm()
	}

	async function resetRuntime() {
		return serial(async () => {
			const [jobs, outbox, actions, actionOutbox] = await Promise.all([
				readJobs(), readOutbox(), readActions(), readActionOutbox(),
			])
			await setStorage({ [JOBS_KEY]: {}, [OUTBOX_KEY]: [], [ACTIONS_KEY]: {}, [ACTION_OUTBOX_KEY]: [] })
			return {
				jobsCleared: Object.keys(jobs).length,
				eventsCleared: outbox.length,
				actionsCleared: Object.keys(actions).length,
				actionEventsCleared: actionOutbox.length,
			}
		})
	}

	background.BridgeClient = {
		BASE_URL,
		ORIGIN,
		HOST_PERMISSION,
		ALARM_NAME,
		PERIOD_MINUTES,
		LEASE_SECONDS,
		REQUEST_TIMEOUT_MS,
		MAX_OUTBOX,
		readConfig,
		readJobs,
		readOutbox,
		readActions,
		readActionOutbox,
		requestJson,
		claimJob,
		claimAction,
		flushOutbox,
		flushActionOutbox,
		reconcileTasks,
		enqueueEvent,
		executeClaimedAction,
		processActions,
		ensureAlarm,
		syncDirectoryRegistry,
		syncConfig,
		processPending,
		resetRuntime,
		isUncertainSubmissionError,
		isExplicitRemoteRejectionError,
		safeIntent,
	}
})(globalThis)
