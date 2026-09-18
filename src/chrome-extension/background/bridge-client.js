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
	const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'uncertain'])
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
			targetCid: normalizeCid(values[TARGET_CID_KEY], '0'),
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

	async function readOutbox() {
		const values = await getStorage(OUTBOX_KEY)
		if (!Array.isArray(values[OUTBOX_KEY])) return []
		return values[OUTBOX_KEY].filter(item => item && typeof item === 'object' && String(item.eventId || '').trim())
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
		const eventPath = /^\/v1\/jobs\/[^\/?#]+\/events$/
		if (rawPath !== '/v1/jobs/claim' && !eventPath.test(rawPath)) {
			throw bridgeError('bridge 路径无效', 'BRIDGE_INVALID_PATH')
		}
		let url
		try { url = new URL(rawPath, BASE_URL) } catch (error) { throw bridgeError('bridge 地址无效', 'BRIDGE_INVALID_URL') }
		if (url.origin !== ORIGIN || url.protocol !== 'http:' || url.username || url.password) {
			throw bridgeError('bridge 地址不在受支持的 loopback 范围内', 'BRIDGE_UNSAFE_URL')
		}
		return url.toString()
	}

	async function requestJson(path, body, token) {
		const auth = String(token || '').trim()
		if (!auth) throw bridgeError('未配置 bridge Bearer token', 'BRIDGE_TOKEN_MISSING')
		const url = bridgeUrl(path)
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
			response = await fetch(url, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: `Bearer ${auth}`,
				},
				body: JSON.stringify(body),
				credentials: 'omit',
				redirect: 'error',
				referrerPolicy: 'no-referrer',
				cache: 'no-store',
				...(controller ? { signal: controller.signal } : {}),
			})
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

	function safeIntent(rawIntent, jobId, targetCid) {
		const input = rawIntent?.intent && typeof rawIntent.intent === 'object' ? rawIntent.intent : rawIntent
		const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
		const safeSource = { ...source }
		for (const name of Object.keys(safeSource)) {
			if (/token|authorization|cookie|secret|headers/i.test(name)) delete safeSource[name]
		}
		const metadataSource = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
			? source.metadata : {}
		const metadata = { ...metadataSource }
		for (const name of Object.keys(metadata)) {
			if (/token|authorization|cookie|secret/i.test(name)) delete metadata[name]
		}
		metadata.bridgeJobId = jobId
		metadata.monitorDownload = true
		return {
			...safeSource,
			jobId,
			sourceSite: String(safeSource.sourceSite || 'javbus').trim().toLowerCase() || 'javbus',
			url: String(source.url || source.magnet || '').trim(),
			mediaType: 'jav',
			processorProfile: 'jav',
			savePathCid: normalizeCid(targetCid || source.savePathCid, '0'),
			metadata,
		}
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
		return ['claimed', 'accepted', 'progress', 'completed', 'failed', 'uncertain'].includes(candidate)
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
		const intent = safeIntent(job.intent, job.jobId, bridgeConfig.targetCid)
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

	async function processPending() {
		if (running) return { skipped: true, running: true }
		running = true
		try {
			const bridgeConfig = await readConfig()
			if (!bridgeConfig.enabled || !bridgeConfig.token) return { disabled: true }
			if (!await hasPermission()) return { permission: false }
			await reconcileTasks()
			if (!await flushOutbox(bridgeConfig)) return { outboxPending: true }

			const jobs = await readJobs()
			const claimed = Object.values(jobs).find(job => job?.status === 'claimed')
			if (claimed) {
				await submitClaimedJob(claimed, bridgeConfig)
				await flushOutbox(bridgeConfig)
				return { jobId: claimed.jobId, resumed: true }
			}

			const claimedJob = await claimJob(bridgeConfig)
			if (!claimedJob) return { empty: true }
			claimedJob.intent = safeIntent(claimedJob.intent, claimedJob.jobId, bridgeConfig.targetCid)
			const saved = await persistClaim(claimedJob)
			if (TERMINAL_JOB_STATES.has(saved.status)) return { jobId: saved.jobId, duplicate: true }
			await submitClaimedJob(saved, bridgeConfig)
			await flushOutbox(bridgeConfig)
			return { jobId: saved.jobId }
		} catch (error) {
			// Network/bridge errors remain recoverable through the next alarm.  Do
			// not log the token or response body; the options page only exposes
			// persisted task and event state.
			return { error: errorCode(error, 'BRIDGE_POLL_FAILED') }
		} finally {
			running = false
		}
	}

	async function syncConfig() {
		return ensureAlarm()
	}

	async function resetRuntime() {
		return serial(async () => {
			const [jobs, outbox] = await Promise.all([readJobs(), readOutbox()])
			await setStorage({ [JOBS_KEY]: {}, [OUTBOX_KEY]: [] })
			return { jobsCleared: Object.keys(jobs).length, eventsCleared: outbox.length }
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
		requestJson,
		claimJob,
		flushOutbox,
		reconcileTasks,
		enqueueEvent,
		ensureAlarm,
		syncConfig,
		processPending,
		resetRuntime,
		isUncertainSubmissionError,
		isExplicitRemoteRejectionError,
		safeIntent,
	}
})(globalThis)
