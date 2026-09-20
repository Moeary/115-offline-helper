;(function (global) {
	'use strict'
	const { STORAGE_KEYS } = global.Push115.Config

	function parseCookieString(rawCookie) {
		if (!rawCookie) return ''
		if (typeof rawCookie === 'string') return rawCookie.trim()
		if (typeof rawCookie === 'object') {
			const parts = []
			if (rawCookie.UID) parts.push(`UID=${rawCookie.UID}`)
			if (rawCookie.CID) parts.push(`CID=${rawCookie.CID}`)
			if (rawCookie.SEID) parts.push(`SEID=${rawCookie.SEID}`)
			return parts.join('; ')
		}
		return ''
	}

	function is115Host(url) {
		try {
			const hostname = new URL(url).hostname
			return hostname === '115.com' || hostname.endsWith('.115.com')
		} catch (error) {
			return false
		}
	}

	async function getPersistedCookie() {
		const data = await chrome.storage.local.get(STORAGE_KEYS.COOKIE)
		return data[STORAGE_KEYS.COOKIE] || ''
	}

	async function get115Cookies() {
		const filters = [
			{ domain: '.115.com' },
			{ domain: '115.com' },
			{ url: 'https://webapi.115.com/' },
		]
		const unique = new Map()
		for (const filter of filters) {
			try {
				const cookies = await chrome.cookies.getAll(filter)
				for (const cookie of Array.isArray(cookies) ? cookies : []) {
					const key = `${cookie.name || ''}|${cookie.domain || ''}|${cookie.path || '/'}`
					if (cookie.name && !unique.has(key)) unique.set(key, cookie)
				}
			} catch (error) {
				// A browser may reject one filter form while still allowing the
				// remaining host-scoped filters.  Do not make directory reads fail
				// merely because a duplicate cookie query is unsupported.
			}
		}
		return [...unique.values()]
	}

	async function has115AuthCookies() {
		const cookies = await get115Cookies()
		const names = new Set(cookies.map(cookie => cookie.name))
		return names.has('UID') && names.has('CID') && names.has('SEID')
	}

	async function syncCookieStringToJar(cookieString, options = {}) {
		const { overwrite = true } = options
		const expiresAt = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60
		const pairs = cookieString.split(';').map(item => item.trim()).filter(Boolean)
		for (const pair of pairs) {
			const idx = pair.indexOf('=')
			if (idx <= 0) continue
			const name = pair.slice(0, idx).trim()
			const value = pair.slice(idx + 1).trim()
			if (!name || !value) continue
			try {
				if (!overwrite) {
					const existing = await chrome.cookies.get({ url: 'https://115.com/', name })
					if (existing?.value) continue
				}
				await chrome.cookies.set({
					url: 'https://115.com/', name, value, domain: '.115.com', path: '/', secure: true,
					sameSite: 'no_restriction', expirationDate: expiresAt,
				})
			} catch (error) {
				console.warn('Set cookie failed:', name, error?.message || error)
			}
		}
	}

	async function restorePersistedCookieIfMissing() {
		if (await has115AuthCookies()) return false
		const saved = await getPersistedCookie()
		if (!saved) return false
		await syncCookieStringToJar(saved, { overwrite: false })
		return true
	}

	async function persistCookieToStorageAndJar(rawCookie) {
		const cookieString = parseCookieString(rawCookie)
		if (!cookieString) return ''
		await chrome.storage.local.set({ [STORAGE_KEYS.COOKIE]: cookieString })
		await syncCookieStringToJar(cookieString)
		return cookieString
	}

	async function getCookie() {
		const cookies = await get115Cookies()
		let cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
		if (!cookieString) {
			cookieString = await getPersistedCookie()
			if (cookieString) await syncCookieStringToJar(cookieString, { overwrite: false })
		}
		return cookieString
	}

	global.Push115.Background = global.Push115.Background || {}
	global.Push115.Background.Auth = {
		is115Host,
		restorePersistedCookieIfMissing,
		persistCookieToStorageAndJar,
		getCookie,
	}
})(globalThis)
