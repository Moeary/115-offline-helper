const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')
const load = (context, relative) => vm.runInContext(
	fs.readFileSync(path.join(extension, relative), 'utf8'),
	context,
	{ filename: relative },
)

test('FilesApi reads and OfflineApi task polls share the account request limiter', { timeout: 3000 }, async () => {
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
					async data(request) {
						starts.push(Date.now())
						active += 1
						maximumActive = Math.max(maximumActive, active)
						await new Promise(resolve => setTimeout(resolve, 8))
						active -= 1
						return request.url.includes('task_lists') ? { state: true, tasks: [] } : { state: true, data: [] }
					},
				},
			},
		},
	})
	load(context, 'background/api/offline.js')
	load(context, 'background/api/files.js')
	const files = context.Push115.Background.FilesApi
	const offline = context.Push115.Background.OfflineApi
	await Promise.all([files.list('10'), offline.getTasks(), files.move('20', '10')])

	assert.equal(maximumActive, 1)
	assert.equal(starts.length, 3)
	for (let index = 1; index < starts.length; index += 1) {
		assert.ok(starts[index] - starts[index - 1] >= 450, `request ${index} was not spaced`)
	}
	assert.equal(files.requestPolicy.concurrency, 1)
	assert.equal(files.requestPolicy.minIntervalMs, 500)
	assert.equal(offline.requestPolicy.minIntervalMs, 500)
})

test('TaskMonitor polls active tasks in bounded round-robin slices', async () => {
	const key = 'push115_task_monitor_cursor'
	const storage = { push115_auto_delete_small: true, push115_delete_size_threshold: 100 }
	const records = Array.from({ length: 6 }, (_, index) => ({
		taskId: `task-${index + 1}`,
		status: 'waiting',
		processorProfile: 'generic',
		mediaType: 'generic',
		createdAt: Date.now(),
		attempts: 0,
	}))
	const context = vm.createContext({
		console,
		Date,
		Promise,
		setTimeout,
		Push115: {},
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return { ...storage }
						const wanted = Array.isArray(keys) ? keys : [keys]
						return Object.fromEntries(wanted.map(item => [item, storage[item]]))
					},
					async set(values) { Object.assign(storage, values) },
				},
			},
			runtime: { sendMessage: async () => ({}) },
			alarms: { get: async () => true, create: async () => {} },
			notifications: { create: async () => {} },
		},
	})
	load(context, 'shared/config.js')
	context.Push115.AnimeSeries = { needsFlatten: () => false }
	context.Push115.Background = {
		FilesApi: { requestPolicy: { concurrency: 1, minIntervalMs: 500 } },
		OfflineApi: { getTasks: async () => [] },
		Processors: { Helpers: { isFolder: () => false, getItemName: () => '' } },
		TaskStore: {
			read: async () => records,
			persist: async task => {
				const index = records.findIndex(item => item.taskId === task.taskId)
				if (index >= 0) records[index] = task
			},
			taskIsActive: task => ['waiting', 'processing'].includes(task?.status),
			appendLog: () => {},
		},
	}
	load(context, 'background/tasks/monitor.js')
	const monitor = context.Push115.Background.TaskMonitor
	assert.equal(monitor.MONITOR_POLICY.concurrency, 1)
	assert.equal(monitor.MONITOR_POLICY.maxTasksPerPass, 2)
	assert.equal(monitor.MONITOR_POLICY.minIntervalMs, 500)

	await monitor.processPending()
	assert.deepEqual(records.map(task => task.attempts), [1, 1, 0, 0, 0, 0])
	assert.equal(storage[key], 'task-3')
	await monitor.processPending()
	assert.deepEqual(records.map(task => task.attempts), [1, 1, 1, 1, 0, 0])
	assert.equal(storage[key], 'task-5')
	await monitor.processPending()
	assert.deepEqual(records.map(task => task.attempts), [1, 1, 1, 1, 1, 1])
	assert.equal(storage[key], 'task-1')
	await monitor.processPending()
	assert.deepEqual(records.map(task => task.attempts), [2, 2, 1, 1, 1, 1])
	assert.equal(storage[key], 'task-3')
})
