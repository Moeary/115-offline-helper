;(function (global) {
	'use strict'
	const adapters = global.Push115.SiteAdapters = global.Push115.SiteAdapters || {}
	let delegatedHandlersInstalled = false

	function extractPageMetadata() {
		return {
			title: (document.querySelector('meta[property="og:title"]')?.content || document.title || '').trim(),
			code: '',
			pageCode: '',
			pageUrl: location.href,
		}
	}

	function discoverDownloads(root = document) {
		return [...root.querySelectorAll('a[href^="magnet:"], a[href^="ed2k:"]')]
			.filter(anchor => global.Push115.DownloadIntent.isDownloadUrl(anchor.href))
			.map(anchor => ({
				element: anchor,
				url: anchor.href,
				title: anchor.textContent.trim() || global.Push115.DownloadIntent.extractDisplayName(anchor.href) || document.title,
			}))
	}

	function getDefaultProcessorProfile() {
		return global.Push115.Content.getProfile('generic')?.defaultProcessorProfile || 'generic'
	}

	function selectedText() {
		const active = document.activeElement
		if (active) {
			const tag = active.tagName
			const type = String(active.type || 'text').toLowerCase()
			const canRead = tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search', 'url', 'email', 'tel'].includes(type))
			if (canRead && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
				return String(active.value || '').slice(active.selectionStart, active.selectionEnd).trim()
			}
		}
		return global.getSelection?.()?.toString().trim() || ''
	}

	function installLegacyLinkHandlers() {
		if (delegatedHandlersInstalled) return
		delegatedHandlersInstalled = true
		// Keep the original Generic click/copy workflow available while the inline
		// button remains the primary, non-invasive enhancement.
		document.addEventListener('click', event => {
			if (global.__push115ContentRuntimeMode === 'sites') return
			if (global.Push115.Content.getProfile('generic')?.enabled !== true) return
			const anchor = event.target?.closest?.('a')
			if (!anchor || !anchor.href || !global.Push115.DownloadIntent.isDownloadUrl(anchor.href)) return
			event.preventDefault()
			event.stopPropagation()
			void global.Push115.Content.IntentFactory.confirm(adapters.generic, [{
				element: anchor,
				url: anchor.href,
				title: anchor.textContent.trim() || global.Push115.DownloadIntent.extractDisplayName(anchor.href) || document.title,
			}])
		}, true)
		document.addEventListener('copy', () => {
			if (global.__push115ContentRuntimeMode === 'sites') return
			const profile = global.Push115.Content.getProfile('generic') || {}
			if (profile.enabled !== true) return
			const config = global.Push115.Content.getConfig?.(global.Push115.Config.STORAGE_KEYS.AUTO_DETECT)
			if (profile.enhancementMode !== 'click-copy' && config !== true) return
			const selected = selectedText()
			if (!global.Push115.DownloadIntent.isDownloadUrl(selected)) return
			void global.Push115.Content.IntentFactory.confirm(adapters.generic, [{ url: selected, title: document.title }])
		})
	}

	function addInlineButton(download) {
		if (download.element.dataset.push115Enhanced === 'generic') return
		download.element.dataset.push115Enhanced = 'generic'
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'push115-inline-btn'
		button.dataset.push115Site = 'generic'
		button.textContent = '发送到115'
		button.addEventListener('click', event => {
			event.preventDefault()
			event.stopPropagation()
			void global.Push115.Content.IntentFactory.confirm(adapters.generic, [download])
		})
		download.element.insertAdjacentElement('afterend', button)
	}

	function enhancePage() {
		const profile = global.Push115.Content.getProfile('generic')
		installLegacyLinkHandlers()
		if (profile.inlineSendButton !== false) discoverDownloads().forEach(addInlineButton)
	}

	adapters.generic = {
		id: 'generic',
		matches(currentLocation = location) { return /^https?:$/.test(currentLocation.protocol) },
		extractPageMetadata,
		discoverDownloads,
		enhancePage,
		getDefaultProcessorProfile,
	}
})(globalThis)
