;(function (global) {
	'use strict'
	const { STORAGE_KEYS, SITE_DEFINITIONS } = global.Push115.Config
	const GENERIC_ID = 'push115-content-generic'
	const SITES_ID = 'push115-content-sites'
	const LEGACY_ID = 'push115-content-script'
	let syncChain = Promise.resolve()
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

	async function originGranted(origin) {
		return chrome.permissions.contains({ origins: [origin] })
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

	async function buildRegistrations() {
		const config = await global.Push115.Config.loadConfig()
		const profiles = config[STORAGE_KEYS.SITE_PROFILES]
		const registrations = []
		const siteMatches = []
		for (const siteId of ['javbus', 'nyaa', 'sukebei', 'mikan']) {
			if (!profiles[siteId]?.enabled) continue
			for (const origin of SITE_DEFINITIONS[siteId].matches) {
				if (await originGranted(origin)) siteMatches.push(origin)
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

	function sync() {
		syncChain = syncChain.catch(() => {}).then(async () => {
			await unregister()
			const registrations = await buildRegistrations()
			if (registrations.length > 0) await chrome.scripting.registerContentScripts(registrations)
			return registrations
		})
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
					const files = script.js || (script.id === SITES_ID ? SITE_CONTENT_FILES : GENERIC_CONTENT_FILES)
					await chrome.scripting.executeScript({ target: { tabId: tab.id }, files })
					count += 1
				} catch (error) {
					// Restricted browser pages and tabs closed mid-loop are ignored.
				}
			}
		}
		return count
	}

	async function syncAndInject() {
		const registrations = await sync()
		await injectExisting(registrations)
		return registrations
	}

	global.Push115.Background.ContentScripts = {
		GENERIC_ID,
		SITES_ID,
		CONTENT_FILES: GENERIC_CONTENT_FILES,
		COMMON_CONTENT_FILES,
		SITE_CONTENT_FILES,
		GENERIC_CONTENT_FILES,
		matchesPattern,
		unregister,
		sync,
		injectExisting,
		syncAndInject,
	}
})(globalThis)
