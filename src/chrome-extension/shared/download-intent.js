;(function (global) {
	'use strict'

	const MEDIA_TYPES = Object.freeze(['generic', 'jav', 'anime'])

	function normalizeCode(value) {
		const text = String(value || '')
			.toUpperCase()
			.replace(/\.[^.]+$/, '')
			.replace(/[\[\]【】()]/g, ' ')
			.replace(/[@_.]/g, '-')
		const fc2 = text.match(/\b(FC2-(?:PPV-)?\d{5,7})\b/)
		if (fc2) return fc2[1]
		const general = text.match(/\b([A-Z]{2,6})[-\s]?(\d{2,5})(?:[-\s]?([A-Z]))?\b/)
		if (!general) return ''
		const invalid = new Set([
			'FULL', 'H264', 'HEVC', 'MP4', 'AVI', 'MKV', 'WMV', 'JPG', 'PNG', 'COM', 'NET', 'WWW', 'JAV',
			'HD', 'FHD', 'RESTORE', 'UNCENSORED', 'CHINESE', 'ARCHIVE', 'XXX',
		])
		if (invalid.has(general[1])) return ''
		return `${general[1]}-${general[2]}${general[3] ? `-${general[3]}` : ''}`
	}

	function extractBtih(url) {
		try {
			const parsed = new URL(String(url || ''))
			const xtValues = parsed.searchParams.getAll('xt')
			for (const xt of xtValues) {
				const match = xt.match(/^urn:btih:([a-z0-9]{32}|[a-f0-9]{40})$/i)
				if (match) return match[1].toLowerCase()
			}
		} catch (error) {
			return ''
		}
		return ''
	}

	function extractDisplayName(url) {
		try {
			return String(new URL(String(url || '')).searchParams.get('dn') || '').trim()
		} catch (error) {
			return ''
		}
	}

	function isDownloadUrl(url) {
		const value = String(url || '').trim()
		if (/^ed2k:\/\/\|file\|/i.test(value)) return true
		if (!/^magnet:\?/i.test(value)) return false
		try {
			return new URL(value).searchParams.getAll('xt').some(xt => /^urn:[a-z0-9]+:[a-z0-9]{32,}$/i.test(xt))
		} catch (error) {
			return false
		}
	}

	function dedupeKey(url) {
		const value = String(url || '').trim()
		const btih = extractBtih(value)
		return btih ? `btih:${btih}` : `url:${value}`
	}

	function parseLines(text) {
		const rows = []
		const seen = new Map()
		String(text || '').split(/\r?\n/).forEach((raw, index) => {
			const url = raw.trim()
			if (!url) return
			if (!isDownloadUrl(url)) {
				rows.push({ line: index + 1, url, status: 'invalid', message: '不是有效的 Magnet/ED2K 链接' })
				return
			}
			const key = dedupeKey(url)
			if (seen.has(key)) {
				rows.push({ line: index + 1, url, key, status: 'duplicate', duplicateOf: seen.get(key), message: '重复链接' })
				return
			}
			seen.set(key, index + 1)
			rows.push({ line: index + 1, url, key, status: 'valid', message: '' })
		})
		return rows
	}

	function create(input = {}, defaults = {}) {
		const value = { ...defaults, ...input }
		const url = String(value.url || value.magnet || '').trim()
		if (!isDownloadUrl(url)) throw new Error('不支持的离线下载链接')
		const sourceSite = String(value.sourceSite || value.source || 'generic').trim().toLowerCase() || 'generic'
		const mediaType = MEDIA_TYPES.includes(value.mediaType) ? value.mediaType : 'generic'
		const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
			? { ...value.metadata }
			: {}
		const explicitCode = normalizeCode(value.code || metadata.pageCode)

		const processorProfile = global.Push115?.Config?.normalizeProcessorProfile(value.processorProfile, 'generic') || 'generic'

		return {
			sourceSite,
			mediaType,
			url,
			title: String(value.title || extractDisplayName(url) || '').trim(),
			code: explicitCode,
			metadata: {
				...metadata,
				btih: metadata.btih || extractBtih(url),
				pageUrl: String(metadata.pageUrl || (global.location?.href ?? '')).trim(),
			},
			savePathCid: global.Push115?.Config?.normalizeCid(value.savePathCid, '0') || '0',
			processorProfile,
		}
	}

	global.Push115 = global.Push115 || {}
	global.Push115.DownloadIntent = {
		MEDIA_TYPES, normalizeCode, extractBtih, extractDisplayName, isDownloadUrl, dedupeKey, parseLines, create,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
