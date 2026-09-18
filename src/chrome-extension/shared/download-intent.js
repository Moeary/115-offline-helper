;(function (global) {
	'use strict'

	const MEDIA_TYPES = Object.freeze(['generic', 'jav', 'anime'])
	const CODE_INVALID_PREFIXES = new Set([
		// Keep the legacy vocabulary and the South Plus page vocabulary together.
		// These words can look like a code when followed by a resolution or part
		// number, but they are never a media catalogue prefix.
		'AD', 'ADS', 'ARCHIVE', 'AV', 'AVI', 'CA', 'CHINESE', 'COM', 'ED2K', 'EP', 'FILE', 'FHD', 'FULL',
		'H264', 'HD', 'HEVC', 'HTTP', 'HTTPS', 'JAV', 'JPG', 'KEYWORD', 'LADA', 'MKV', 'MP4', 'NET', 'PAGE',
		'PART', 'PLUS', 'PNG', 'READ', 'RESTORE', 'RESTORED', 'SAMPLE', 'SEASON', 'SOUTH', 'TEST', 'THREAD',
		'TITLE', 'UNCENSORED', 'VIDEO', 'WEB', 'WMV', 'WWW', 'XXX',
	])
	const CODE_TOKEN = /(?:^|[^A-Z0-9])((?:FC2[-\s]?(?:PPV[-\s]?)?\d{5,7}|[A-Z]{2,6}[-\s]?\d{2,5}(?:[-\s]?[A-Z])?))(?=$|[^A-Z0-9])/g

	function decodeEd2kFileName(value) {
		try { return decodeURIComponent(String(value || '')) } catch (error) { return String(value || '') }
	}

	function parseExpectedSize(value) {
		const text = String(value ?? '').replace(/\s+/g, '').trim()
		if (!/^\d+$/.test(text)) return ''
		const number = Number(text)
		return Number.isSafeInteger(number) ? number : text
	}

	function parseEd2k(url) {
		const value = String(url || '').trim()
		const match = value.match(/^ed2k:\/\/\|file\|([^|]*)\|([^|]*)\|([^|]*)\|\/\s*$/i)
		if (!match) return null
		const fileName = decodeEd2kFileName(match[1]).trim()
		const sizeText = String(match[2] || '').replace(/\s+/g, '').trim()
		const hash = String(match[3] || '').replace(/\s+/g, '').trim().toLowerCase()
		if (!fileName || !/^\d+$/.test(sizeText) || !/^[a-f0-9]{32}$/.test(hash)) return null
		return {
			linkType: 'ed2k',
			url: value,
			fileName,
			size: parseExpectedSize(sizeText),
			sizeText,
			hash,
		}
	}

	function formatCode(prefix, number, suffix = '') {
		return `${prefix}-${number}${suffix ? `-${suffix}` : ''}`
	}

	function normalizeCode(value) {
		const text = String(value || '')
			.toUpperCase()
			.replace(/\.[^.]+$/, '')
			.replace(/[\[\]【】()]/g, ' ')
			.replace(/[@_.]/g, '-')
		for (const match of text.matchAll(CODE_TOKEN)) {
			const candidate = String(match[1] || '')
			const fc2 = candidate.match(/^FC2[-\s]?(PPV[-\s]?)?(\d{5,7})$/)
			if (fc2) return fc2[1] ? `FC2-PPV-${fc2[2]}` : `FC2-${fc2[2]}`
			const general = candidate.match(/^([A-Z]{2,6})[-\s]?(\d{2,5})(?:[-\s]?([A-Z]))?$/)
			if (!general || CODE_INVALID_PREFIXES.has(general[1])) continue
			return formatCode(general[1], general[2], general[3])
		}
		return ''
	}

	function extractVideoCode(...values) {
		const candidates = values.length === 1 && Array.isArray(values[0]) ? values[0] : values
		for (const value of candidates) {
			const code = normalizeCode(value)
			if (code) return code
		}
		return ''
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

	function parseDownloadLink(url) {
		const value = String(url || '').trim()
		const ed2k = parseEd2k(value)
		if (ed2k) return ed2k
		if (!/^magnet:\?/i.test(value)) return null
		try {
			const parsed = new URL(value)
			const btih = extractBtih(value)
			// Keep the historical Magnet contract: any well-formed 32+ character
			// URN is accepted.  BTIH is still exposed when it is available for
			// deduplication, while other URN namespaces remain submit-able.
			const validXt = parsed.searchParams.getAll('xt').some(xt => /^urn:[a-z0-9]+:[a-z0-9]{32,}$/i.test(xt))
			if (!validXt) return null
			return {
				linkType: 'magnet',
				url: value,
				fileName: extractDisplayName(value),
				expectedName: extractDisplayName(value),
				size: '',
				sizeText: '',
				hash: '',
				btih,
				params: parsed.searchParams,
			}
		} catch (error) {
			return null
		}
	}

	function isDownloadUrl(url) {
		const value = String(url || '').trim()
		if (parseEd2k(value)) return true
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
		const link = parseDownloadLink(url)
		if (!link) throw new Error('不支持的离线下载链接')
		const sourceSite = String(value.sourceSite || value.source || 'generic').trim().toLowerCase() || 'generic'
		const mediaType = MEDIA_TYPES.includes(value.mediaType) ? value.mediaType : 'generic'
		const metadata = value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
			? { ...value.metadata }
			: {}
		const expectedName = String(
			value.expectedName || metadata.expectedName || link.fileName || link.expectedName || extractDisplayName(url) || '',
		).trim()
		const expectedSize = value.expectedSize !== undefined && value.expectedSize !== null && value.expectedSize !== ''
			? parseExpectedSize(value.expectedSize)
			: link.size || parseExpectedSize(metadata.expectedSize || metadata.ed2kSize)
		const expectedHash = String(value.expectedHash || metadata.expectedHash || link.hash || metadata.ed2kHash || '').trim().toLowerCase()
		const explicitCode = extractVideoCode([value.code, metadata.pageCode, expectedName])
		const explicitJobId = String(value.jobId || metadata.bridgeJobId || '').trim()
		const monitorDownload = value.monitorDownload === true || metadata.monitorDownload === true

		const processorProfile = global.Push115?.Config?.normalizeProcessorProfile(value.processorProfile, 'generic') || 'generic'

		return {
			sourceSite,
			mediaType,
			url,
			title: String(value.title || expectedName || extractDisplayName(url) || '').trim(),
			code: explicitCode,
			jobId: explicitJobId,
			monitorDownload,
			linkType: link.linkType,
			expectedName,
			expectedSize,
			expectedHash,
			jobId: explicitJobId,
			linkType: link.linkType,
			expectedName,
			expectedSize,
			expectedHash,
			metadata: {
				...metadata,
				btih: metadata.btih || extractBtih(url),
				...(link.linkType === 'ed2k' ? {
					fileName: metadata.fileName || link.fileName,
					ed2kFileName: metadata.ed2kFileName || link.fileName,
					ed2kSize: metadata.ed2kSize ?? link.size,
					ed2kHash: metadata.ed2kHash || link.hash,
				} : {}),
				...(explicitJobId && !metadata.bridgeJobId ? { bridgeJobId: explicitJobId } : {}),
				linkType: metadata.linkType || link.linkType,
				expectedName: metadata.expectedName || expectedName,
				expectedSize: metadata.expectedSize ?? expectedSize,
				expectedHash: metadata.expectedHash || expectedHash,
				...(monitorDownload ? { monitorDownload: true } : {}),
				pageUrl: String(metadata.pageUrl || (global.location?.href ?? '')).trim(),
			},
			savePathCid: global.Push115?.Config?.normalizeCid(value.savePathCid, '0') || '0',
			processorProfile,
		}
	}

	global.Push115 = global.Push115 || {}
	global.Push115.DownloadIntent = {
		MEDIA_TYPES, CODE_INVALID_PREFIXES, normalizeCode, extractVideoCode, parseEd2k, parseDownloadLink,
		extractBtih, extractDisplayName, isDownloadUrl, dedupeKey, parseLines, create,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
