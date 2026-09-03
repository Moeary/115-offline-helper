;(function (global) {
	'use strict'
	const adapters = global.Push115.SiteAdapters = global.Push115.SiteAdapters || {}

	function matches(currentLocation = location) {
		return currentLocation.hostname === 'javbus.com' || currentLocation.hostname.endsWith('.javbus.com')
	}

	function codeFromPath() {
		const segment = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '')
		return global.Push115.DownloadIntent.normalizeCode(segment)
	}

	function extractPageMetadata() {
		const titleElement = document.querySelector('.container h3, .movie h3, h3, h1')
		const title = (document.querySelector('meta[property="og:title"]')?.content || titleElement?.textContent || document.title).trim()
		const candidates = [codeFromPath(), titleElement?.textContent, document.querySelector('.info p')?.textContent, title]
		let code = ''
		for (const candidate of candidates) {
			code = global.Push115.DownloadIntent.normalizeCode(candidate)
			if (code) break
		}
		return { title, code, pageCode: code, pageUrl: location.href }
	}

	function discoverDownloads() {
		const unique = new Map()
		for (const anchor of document.querySelectorAll('#magnet-table a[href^="magnet:"], .magnet-name a[href^="magnet:"], a[href^="magnet:"]')) {
			const key = global.Push115.DownloadIntent.dedupeKey(anchor.href)
			if (unique.has(key)) continue
			unique.set(key, { element: anchor, url: anchor.href, title: anchor.textContent.trim() || extractPageMetadata().title })
		}
		return [...unique.values()]
	}

	function getDefaultProcessorProfile() {
		return global.Push115.Content.getProfile('javbus')?.defaultProcessorProfile || 'jav'
	}

	function addInlineButton(download) {
		if (download.element.dataset.push115Enhanced === 'javbus') return
		download.element.dataset.push115Enhanced = 'javbus'
		const button = document.createElement('button')
		button.type = 'button'
		button.className = 'push115-inline-btn'
		button.dataset.push115Site = 'javbus'
		button.textContent = '发送到115'
		button.addEventListener('click', event => {
			event.preventDefault()
			event.stopPropagation()
			void global.Push115.Content.IntentFactory.confirm(adapters.javbus, [download])
		})
		download.element.insertAdjacentElement('afterend', button)
	}

	function enhancePage() {
		const profile = global.Push115.Content.getProfile('javbus')
		if (profile.inlineSendButton !== false) discoverDownloads().forEach(addInlineButton)
	}

	adapters.javbus = { id: 'javbus', matches, extractPageMetadata, discoverDownloads, enhancePage, getDefaultProcessorProfile }
})(globalThis)
