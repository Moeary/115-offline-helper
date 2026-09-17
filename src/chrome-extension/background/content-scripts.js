;(function (global) {
	'use strict'
	const { STORAGE_KEYS, SITE_DEFINITIONS } = global.Push115.Config
	const GENERIC_ID = 'push115-content-generic'
	const SITES_ID = 'push115-content-sites'
	const LEGACY_ID = 'push115-content-script'
	let syncChain = Promise.resolve()
	const tabInjectionChains = new Map()
	const COMMON_CONTENT_FILES = [
		'shared/config.js',
		'shared/path-utils.js',
		'shared/download-intent.js',
		'shared/anime-series.js',
		'shared/messaging.js',
		'content/ui/styles.js',
		'content/ui/feedback.js',
		'content/ui/batch-progress.js',
		'content/ui/submission-queue.js',
		'content/ui/anime-routing.js',
		'content/ui/download-confirmation.js',
		'content/intent-factory.js',
		'content/sites/generic.js',
		'content/sites/javbus.js',
		'content/sites/nyaa.js',
		'content/sites/mikan.js',
		'content/sites/south-plus.js',
	]
	const SITE_CONTENT_FILES = [...COMMON_CONTENT_FILES, 'content/runtime-sites.js', 'content/bootstrap.js']
	const GENERIC_CONTENT_FILES = [...COMMON_CONTENT_FILES, 'content/runtime-generic.js', 'content/bootstrap.js']

	async function unregister(ids = [GENERIC_ID, SITES_ID, LEGACY_ID]) {
		// Chrome rejects the whole request when one of the IDs is not registered.
		// Unregister each ID independently so a missing legacy registration cannot
		// mask an active site registration and make the next register call fail with
		// "Duplicate script ID".
		for (const id of [...new Set(ids)].filter(Boolean)) {
			try {
				await chrome.scripting.unregisterContentScripts({ ids: [id] })
			} catch (error) {
				// Missing registrations are expected on first install and after upgrades.
			}
		}
	}

	async function originGranted(origin, allUrlsGranted) {
		if (await chrome.permissions.contains({ origins: [origin] })) return true
		if (origin === '<all_urls>') return false
		if (allUrlsGranted !== undefined) return allUrlsGranted
		return chrome.permissions.contains({ origins: ['<all_urls>'] })
	}

	function matchesPattern(url, pattern) {
		if (!url || !pattern) return false
		if (pattern === '<all_urls>') return /^https?:/i.test(url)
		const match = String(pattern).match(/^\*:\/\/(\*\.)?([^/]+)\//)
		if (!match) return false
		try {
			const hostname = new URL(url).hostname.toLowerCase()
			const wanted = match[2].toLowerCase()
			return match[1] ? (hostname === wanted || hostname.endsWith(`.${wanted}`)) : hostname === wanted
		} catch (error) {
			return false
		}
	}

	function isSouthPlusThread(url) {
		try {
			const parsed = new URL(url)
			return parsed.protocol === 'http:' || parsed.protocol === 'https:'
				? global.Push115.Config.isSouthPlusHostname(parsed.hostname)
					&& parsed.pathname.replace(/\/+$/, '').toLowerCase() === '/read.php'
				: false
		} catch (error) {
			return false
		}
	}

	function getActiveTabRegistration(url, profiles = {}) {
		if (!/^https?:/i.test(String(url || ''))) return null
		for (const siteId of ['javbus', 'nyaa', 'sukebei', 'mikan', 'southplus']) {
			if (!profiles[siteId]?.enabled) continue
			const definition = SITE_DEFINITIONS[siteId]
			if (!definition?.matches?.some(pattern => matchesPattern(url, pattern))) continue
			if (siteId === 'southplus' && !isSouthPlusThread(url)) continue
			return { id: SITES_ID, siteId, js: SITE_CONTENT_FILES, runAt: 'document_idle' }
		}
		if (profiles.generic?.enabled) {
			return { id: GENERIC_ID, siteId: 'generic', js: GENERIC_CONTENT_FILES, runAt: 'document_idle' }
		}
		return null
	}

	async function buildRegistrations() {
		const config = await global.Push115.Config.loadConfig()
		const profiles = config[STORAGE_KEYS.SITE_PROFILES]
		const allUrlsGranted = await originGranted('<all_urls>')
		const registrations = []
		const siteMatches = []
		for (const siteId of ['javbus', 'nyaa', 'sukebei', 'mikan', 'southplus']) {
			if (!profiles[siteId]?.enabled) continue
			for (const origin of SITE_DEFINITIONS[siteId].matches) {
				if (await originGranted(origin, allUrlsGranted)) siteMatches.push(origin)
			}
		}
		if (siteMatches.length > 0) {
			registrations.push({ id: SITES_ID, matches: [...new Set(siteMatches)], js: SITE_CONTENT_FILES, runAt: 'document_idle' })
		}
		if (profiles.generic?.enabled && await originGranted('<all_urls>')) {
			registrations.push({
				id: GENERIC_ID,
				matches: ['<all_urls>'],
				...(siteMatches.length > 0 ? { excludeMatches: [...new Set(siteMatches)] } : {}),
				js: GENERIC_CONTENT_FILES,
				runAt: 'document_idle',
			})
		}
		return registrations
	}

	function runtimeModeFor(script) {
		return script?.id === GENERIC_ID ? 'generic' : 'sites'
	}

	function runtimeAdapterFor(script) {
		// All dedicated-site registrations share one file bundle. Requiring the
		// newest South Plus adapter here also repairs an isolated world left by a
		// pre-South-Plus extension version after an extension reload.
		return script?.id === GENERIC_ID ? 'generic' : 'southplus'
	}

	async function hasContentRuntime(tabId, script) {
		const mode = runtimeModeFor(script)
		const adapter = runtimeAdapterFor(script)
		try {
			const results = await chrome.scripting.executeScript({
				target: { tabId },
				func: (expectedMode, expectedAdapter) => Boolean(
					globalThis.__push115ContentRuntime
					&& globalThis.__push115ContentRuntimeMode === expectedMode
					&& globalThis.Push115?.SiteAdapters?.[expectedAdapter],
				),
				args: [mode, adapter],
			})
			return results?.[0]?.result === true
		} catch (error) {
			// The check is best effort. Restricted pages will also reject the real
			// file injection below, while ordinary pages can still be repaired.
			return false
		}
	}

	function injectTab(tab, script) {
		const tabId = tab?.id
		if (!tabId) return Promise.resolve(false)
		const previous = tabInjectionChains.get(tabId) || Promise.resolve()
		const next = previous.catch(() => {}).then(async () => {
			if (await hasContentRuntime(tabId, script)) return false
			const files = script.js || (script.id === SITES_ID ? SITE_CONTENT_FILES : GENERIC_CONTENT_FILES)
			await chrome.scripting.executeScript({ target: { tabId }, files })
			return true
		})
		tabInjectionChains.set(tabId, next)
		return next.finally(() => {
			if (tabInjectionChains.get(tabId) === next) tabInjectionChains.delete(tabId)
		})
	}

	async function syncRegistrations() {
		await unregister()
		const registrations = await buildRegistrations()
		if (registrations.length > 0) await chrome.scripting.registerContentScripts(registrations)
		return registrations
	}

	function sync() {
		syncChain = syncChain.catch(() => {}).then(syncRegistrations)
		return syncChain
	}

	async function injectExisting(registrations = null) {
		const scripts = registrations || await buildRegistrations()
		let count = 0
		for (const script of scripts) {
			const tabs = await chrome.tabs.query({ url: script.matches })
			for (const tab of tabs) {
				if (!tab.id || script.excludeMatches?.some(pattern => matchesPattern(tab.url, pattern))) continue
				try {
					if (await injectTab(tab, script)) count += 1
				} catch (error) {
					// Restricted browser pages and tabs closed mid-loop are ignored.
				}
			}
		}
		return count
	}

	async function injectActiveTab() {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
		const tab = tabs?.[0]
		const config = await global.Push115.Config.loadConfig()
		const profiles = config[STORAGE_KEYS.SITE_PROFILES] || {}
		const registration = getActiveTabRegistration(tab?.url, profiles)
		if (!tab?.id || !registration) {
			return { injected: false, siteId: registration?.siteId || '', reason: 'no-matching-page' }
		}
		try {
			await injectTab(tab, registration)
			return { injected: true, siteId: registration.siteId }
		} catch (error) {
			// activeTab is intentionally best-effort: restricted pages and a tab
			// closing during popup startup must not make the popup unusable.
			return { injected: false, siteId: registration.siteId, reason: 'injection-failed' }
		}
	}

	function syncAndInject() {
		syncChain = syncChain.catch(() => {}).then(async () => {
			const registrations = await syncRegistrations()
			await injectExisting(registrations)
			return registrations
		})
		return syncChain
	}

	global.Push115.Background.ContentScripts = {
		GENERIC_ID,
		SITES_ID,
		CONTENT_FILES: GENERIC_CONTENT_FILES,
		COMMON_CONTENT_FILES,
		SITE_CONTENT_FILES,
		GENERIC_CONTENT_FILES,
		matchesPattern,
		getActiveTabRegistration,
		unregister,
		sync,
		injectExisting,
		injectActiveTab,
		syncAndInject,
	}
})(globalThis)
