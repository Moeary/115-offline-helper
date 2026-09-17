const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function makeEnvironment({ tabUrl = '', profiles = {}, executeError = null, permissionsContains = async () => false } = {}) {
	const executions = []
	const registrations = []
	const injectedModes = new Map()
	let messageListener = null
	const context = vm.createContext({
		console,
		URL,
		Push115: { Background: {} },
		chrome: {
			storage: {
				local: {
					async get() {
						return { push115_site_profiles: profiles }
					},
				},
			},
			permissions: { contains: permissionsContains },
			tabs: {
				query: async () => tabUrl ? [{ id: 71, url: tabUrl }] : [],
			},
			scripting: {
				unregisterContentScripts: async () => {},
				registerContentScripts: async details => { registrations.push(details) },
				executeScript: async details => {
					executions.push(details)
					if (executeError) throw executeError
					if (details.func) return [{ result: injectedModes.get(details.target.tabId) === details.args?.[0] }]
					injectedModes.set(
						details.target.tabId,
						details.files?.includes('content/runtime-generic.js') ? 'generic' : 'sites',
					)
					return []
				},
			},
			runtime: {
				onMessage: { addListener(listener) { messageListener = listener } },
			},
		},
	})
	const load = relative => vm.runInContext(
		fs.readFileSync(path.join(extension, relative), 'utf8'),
		context,
		{ filename: relative },
	)
	load('shared/config.js')
	load('background/content-scripts.js')
	load('background/router.js')
	context.Push115.Background.Router.listen()
	const invoke = action => new Promise((resolve, reject) => {
		if (!messageListener) return reject(new Error('runtime message listener is not registered'))
		messageListener({ action }, {}, resolve)
	})
	return { context, executions, registrations, invoke }
}

const disabledProfiles = Object.freeze({
	generic: { enabled: false },
	javbus: { enabled: false },
	nyaa: { enabled: false },
	sukebei: { enabled: false },
	mikan: { enabled: false },
	southplus: { enabled: false },
})

test('active-tab registration chooses South Plus only for read.php threads', () => {
	const environment = makeEnvironment({ profiles: { ...disabledProfiles, southplus: { enabled: true } } })
	const scripts = environment.context.Push115.Background.ContentScripts

	const thread = scripts.getActiveTabRegistration(
		'https://www.south-plus.net/read.php?tid-2960797-keyword-av%7Cav.html',
		{ ...disabledProfiles, southplus: { enabled: true } },
	)
	assert.equal(thread?.id, scripts.SITES_ID)
	assert.equal(thread?.siteId, 'southplus')
	assert.equal(thread?.js.includes('content/sites/south-plus.js'), true)
	assert.equal(thread?.js.includes('content/runtime-sites.js'), true)
	assert.equal(thread?.js.includes('content/runtime-generic.js'), false)

	assert.equal(scripts.getActiveTabRegistration(
		'https://www.south-plus.net/search.php?keyword=av',
		{ ...disabledProfiles, southplus: { enabled: true } },
	), null)
	assert.equal(environment.executions.length, 0)
})

test('active-tab registration respects disabled sites and falls back to enabled Generic', () => {
	const environment = makeEnvironment()
	const scripts = environment.context.Push115.Background.ContentScripts
	const southPlusUrl = 'https://south-plus.net/read.php?tid-1'

	assert.equal(scripts.getActiveTabRegistration(southPlusUrl, disabledProfiles), null)
	const generic = scripts.getActiveTabRegistration('https://example.org/page', {
		...disabledProfiles,
		generic: { enabled: true },
	})
	assert.equal(generic?.id, scripts.GENERIC_ID)
	assert.equal(generic?.siteId, 'generic')
	assert.equal(generic?.js.includes('content/runtime-generic.js'), true)
	assert.equal(scripts.getActiveTabRegistration('chrome://extensions/', {
		...disabledProfiles,
		generic: { enabled: true },
	}), null)
})

test('all-url permission covers dedicated South Plus origins', async () => {
	const environment = makeEnvironment({
		profiles: { ...disabledProfiles, southplus: { enabled: true } },
		permissionsContains: async ({ origins }) => origins.includes('<all_urls>'),
	})
	const registrations = await environment.context.Push115.Background.ContentScripts.sync()

	assert.equal(registrations.length, 1)
	assert.deepEqual([...registrations[0].matches], [
		'*://south-plus.net/*',
		'*://www.south-plus.net/*',
	])
	assert.equal(environment.registrations.length, 1)
	assert.equal(environment.registrations[0][0].id, registrations[0].id)
})

test('syncAndInject fills an already-open South Plus tab after startup', async () => {
	const environment = makeEnvironment({
		tabUrl: 'https://www.south-plus.net/read.php?tid-2960797',
		profiles: { ...disabledProfiles, southplus: { enabled: true } },
		permissionsContains: async ({ origins }) => origins.includes('<all_urls>'),
	})
	const registrations = await environment.context.Push115.Background.ContentScripts.syncAndInject()

	assert.equal(registrations.length, 1)
	const fileExecutions = environment.executions.filter(execution => execution.files)
	assert.equal(fileExecutions.length, 1)
	assert.equal(fileExecutions[0].target.tabId, 71)
	assert.equal(fileExecutions[0].files.includes('content/sites/south-plus.js'), true)
})

test('repeated injection reuses the existing page runtime', async () => {
	const environment = makeEnvironment({
		tabUrl: 'https://www.south-plus.net/read.php?tid-2960797',
		profiles: { ...disabledProfiles, southplus: { enabled: true } },
		permissionsContains: async ({ origins }) => origins.includes('<all_urls>'),
	})
	await environment.context.Push115.Background.ContentScripts.syncAndInject()
	await environment.invoke('INJECT_ACTIVE_TAB')

	assert.equal(environment.executions.filter(execution => execution.files).length, 1)
})

test('service-worker startup repairs tabs opened before extension reload', () => {
	const worker = fs.readFileSync(path.join(extension, 'background/service-worker.js'), 'utf8')
	const initializeBody = worker.match(/async function initialize\(\) \{([\s\S]*?)\n\}/)?.[1] || ''
	assert.match(initializeBody, /ContentScripts\.syncAndInject\(\)/)
	assert.doesNotMatch(initializeBody, /ContentScripts\.sync\(\)/)
})

test('popup injection action executes the selected South Plus scripts on the active tab', async () => {
	const environment = makeEnvironment({
		tabUrl: 'https://www.south-plus.net/read.php?tid-2960797',
		profiles: { ...disabledProfiles, southplus: { enabled: true } },
	})
	const response = await environment.invoke('INJECT_ACTIVE_TAB')

	assert.equal(response.success, true)
	assert.equal(response.injected, true)
	assert.equal(response.siteId, 'southplus')
	const fileExecutions = environment.executions.filter(execution => execution.files)
	assert.equal(fileExecutions.length, 1)
	assert.equal(fileExecutions[0].target.tabId, 71)
	assert.equal(fileExecutions[0].files.includes('content/sites/south-plus.js'), true)
})

test('active-tab injection is best effort when the browser rejects the target tab', async () => {
	const environment = makeEnvironment({
		tabUrl: 'https://www.south-plus.net/read.php?tid-2960797',
		profiles: { ...disabledProfiles, southplus: { enabled: true } },
		executeError: new Error('restricted page'),
	})
	const response = await environment.invoke('INJECT_ACTIVE_TAB')

	assert.equal(response.success, true)
	assert.equal(response.injected, false)
	assert.equal(response.siteId, 'southplus')
	assert.equal(response.reason, 'injection-failed')
})

test('popup requests the active-tab fallback without making it a blocking UI action', () => {
	const popup = fs.readFileSync(path.join(extension, 'ui/popup/index.js'), 'utf8')
	assert.match(popup, /sendMessage\('INJECT_ACTIVE_TAB'\)\.catch\(\(\) => \{\}\)/)
})
