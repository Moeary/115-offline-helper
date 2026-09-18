const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function load(context, relative) {
	return vm.runInContext(
		fs.readFileSync(path.join(extension, relative), 'utf8'),
		context,
		{ filename: relative },
	)
}

function parserEnvironment() {
	const context = vm.createContext({
		console,
		URL,
		URLSearchParams,
		structuredClone,
		location: { href: 'https://www.south-plus.net/read.php?tid-115' },
	})
	load(context, 'shared/config.js')
	load(context, 'shared/download-intent.js')
	return context.Push115.DownloadIntent
}

function storeEnvironment() {
	const data = {}
	const context = vm.createContext({
		console,
		URL,
		URLSearchParams,
		structuredClone,
		location: { href: 'https://www.south-plus.net/read.php?tid-115' },
		chrome: {
			storage: {
				local: {
					async get(keys) {
						if (keys == null) return structuredClone(data)
						const wanted = Array.isArray(keys) ? keys : [keys]
						return Object.fromEntries(wanted.map(key => [key, structuredClone(data[key])]))
					},
					async set(values) { Object.assign(data, structuredClone(values)) },
				},
			},
			runtime: { sendMessage: async () => ({}) },
			alarms: { get: async () => true, create: async () => {} },
		},
	})
	load(context, 'shared/config.js')
	load(context, 'shared/download-intent.js')
	context.Push115.Background = {
		TaskMonitor: { ensureAlarm: async () => {}, processPending: async () => {} },
	}
	load(context, 'background/tasks/store.js')
	return { context, data, intent: context.Push115.DownloadIntent, store: context.Push115.Background.TaskStore }
}

const HASH = 'ABCDEF0123456789ABCDEF0123456789'
const ed2k = (name, size = '123') => `ed2k://|file|${name}|${size}|${HASH}|/`

test('attached ED2K samples preserve FC2 and compact SNOS catalogue codes', () => {
	const intent = parserEnvironment()
	const samples = [
		{ name: 'MIDA-190 4K60fps.mp4', code: 'MIDA-190' },
		{ name: 'FC2-PPV-123456 1080p.mp4', code: 'FC2-PPV-123456' },
		{ name: 'SNOS00301_sample.mkv', code: 'SNOS-00301' },
	]
	for (const sample of samples) {
		const parsed = intent.parseEd2k(ed2k(encodeURIComponent(sample.name)))
		assert.ok(parsed, sample.name)
		assert.equal(parsed.fileName, sample.name)
		assert.equal(intent.extractVideoCode(parsed.fileName), sample.code)
	}
	assert.equal(intent.normalizeCode('FC2 PPV 123456'), 'FC2-PPV-123456')
	assert.equal(intent.normalizeCode('FC2123456'), 'FC2-123456')
})

test('code extraction skips blacklist prefixes and continues to a later real code', () => {
	const intent = parserEnvironment()
	assert.equal(intent.extractVideoCode('EP01 1080p SAMPLE-001 MIDA-190 restored.mp4'), 'MIDA-190')
	assert.equal(intent.extractVideoCode('ARCHIVE-001 / READ-02 / SNOS00301_sample.mkv'), 'SNOS-00301')
	assert.equal(intent.normalizeCode('HD-1080p'), '')
})

test('malformed ED2K links are rejected without accepting partial fields', () => {
	const intent = parserEnvironment()
	const malformed = [
		'ed2k://|file|name.mp4|123|ABCDEF0123456789ABCDEF0123456789',
		ed2k('name.mp4', '12.3'),
		ed2k('name.mp4', '-123'),
		ed2k('name.mp4', '123').replace(HASH, 'ABCDEF0123456789'),
		ed2k('', '123'),
		'ed2k://|server|example|4662|/',
	]
	for (const value of malformed) {
		assert.equal(intent.parseEd2k(value), null, value)
		assert.equal(intent.isDownloadUrl(value), false, value)
	}
})

test('percent-encoded ED2K filename is decoded before code and expected metadata extraction', () => {
	const intent = parserEnvironment()
	const url = ed2k('%5BMIDA-190%5D%20restored%20%26%20sample.mp4', '456')
	const parsed = intent.parseDownloadLink(url)
	assert.equal(parsed.fileName, '[MIDA-190] restored & sample.mp4')
	const created = intent.create({
		url,
		sourceSite: 'southplus',
		mediaType: 'jav',
		processorProfile: 'jav',
	})
	assert.equal(created.expectedName, '[MIDA-190] restored & sample.mp4')
	assert.equal(created.expectedSize, 456)
	assert.equal(created.expectedHash, HASH.toLowerCase())
	assert.equal(created.code, 'MIDA-190')
	assert.equal(created.metadata.ed2kFileName, created.expectedName)
})

test('queue persists link type, job ID, monitor flag, and expected ED2K fields', async () => {
	const e = storeEnvironment()
	const url = ed2k('%5BSNOS00301%5D%20sample.mkv', '789')
	const task = await e.store.queue({
		intent: {
			url,
			sourceSite: 'southplus',
			mediaType: 'jav',
			processorProfile: 'jav',
			jobId: 'bridge-job-17',
			monitorDownload: true,
		},
		monitor: true,
	})
	const saved = (await e.store.read())[0]
	assert.equal(saved.taskId, task.taskId)
	assert.equal(saved.linkType, 'ed2k')
	assert.equal(saved.jobId, 'bridge-job-17')
	assert.equal(saved.monitorDownload, true)
	assert.equal(saved.expectedName, '[SNOS00301] sample.mkv')
	assert.equal(saved.expectedSize, 789)
	assert.equal(saved.expectedHash, HASH.toLowerCase())
	assert.equal(saved.metadata.expectedName, saved.expectedName)
	assert.equal(saved.metadata.expectedSize, 789)
	assert.equal(saved.metadata.expectedHash, HASH.toLowerCase())
	assert.equal(saved.metadata.bridgeJobId, 'bridge-job-17')
	assert.equal(saved.status, 'waiting')
})
