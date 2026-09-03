;(function (global) {
	'use strict'
	const content = global.Push115.Content = global.Push115.Content || {}
	const keys = global.Push115.Config.STORAGE_KEYS
	let config = null
	let observer = null
	let refreshTimer = null

	content.getConfig = key => config?.[key]
	content.getProfile = siteId => config?.[keys.SITE_PROFILES]?.[siteId] || global.Push115.Config.DEFAULT_SITE_PROFILES[siteId]
	const getRuntimeMode = () => global.__push115ContentRuntimeMode || 'auto'

	function activeAdapters() {
		if (!config) return []
		const matching = Object.values(global.Push115.SiteAdapters || {}).filter(adapter => {
			const profile = content.getProfile(adapter.id)
			return profile?.enabled === true && adapter.matches(location)
		})
		if (getRuntimeMode() === 'generic') return matching.filter(adapter => adapter.id === 'generic')
		if (getRuntimeMode() === 'sites') return matching.filter(adapter => adapter.id !== 'generic')
		// A dedicated adapter owns its page; Generic remains the fallback for all other sites.
		return matching.some(adapter => adapter.id !== 'generic') ? matching.filter(adapter => adapter.id !== 'generic') : matching
	}

	function enhance() {
		for (const adapter of activeAdapters()) {
			try { adapter.enhancePage() } catch (error) { console.error(`[push115:${adapter.id}] enhance failed`, error) }
		}
	}

	function scheduleEnhance() {
		clearTimeout(refreshTimer)
		refreshTimer = setTimeout(enhance, 250)
	}

	async function refresh() {
		config = await global.Push115.Config.loadConfig()
		content.Styles.ensure()
		for (const element of document.querySelectorAll('[data-push115-native]')) {
			const profile = content.getProfile(element.dataset.push115Site)
			if (profile?.enabled === true && profile.batchSelection !== false) continue
			element.classList.remove('push115-row-check')
			delete element.dataset.push115Site
			delete element.dataset.key
			delete element.dataset.push115Native
		}
		// Native Mikan row checkboxes may be reused by its Adapter. Keep those
		// controls across config refreshes; all other injected controls are ours.
		for (const element of document.querySelectorAll('[data-push115-site]:not([data-push115-native])')) element.remove()
		for (const element of document.querySelectorAll('[data-push115-enhanced]')) delete element.dataset.push115Enhanced
		enhance()
		if (!observer) {
			observer = new MutationObserver(scheduleEnhance)
			observer.observe(document.documentElement, { childList: true, subtree: true })
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area === 'local' && (changes[keys.SITE_PROFILES] || changes[keys.AUTO_DETECT] || changes[keys.SAVE_PATH_LIST])) void refresh()
			})
		}
	}

	if (global.__push115ContentRuntime) void global.__push115ContentRuntime.refresh()
	else {
		global.__push115ContentRuntime = { refresh }
		void refresh()
	}
})(globalThis)
