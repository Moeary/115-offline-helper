;(function (global) {
	'use strict'

	// Anime metadata is shared by the content adapter and the background
	// processor.  Keeping the small amount of parsing here avoids making the
	// processor depend on a site's DOM and keeps Mikan-specific hints inside the
	// DownloadIntent metadata.
	function text(value) {
		return String(value ?? '').replace(/\s+/g, ' ').trim()
	}

	function sanitizeSeriesName(value) {
		const result = text(value)
			.replace(/[\\/:*?"<>|]/g, ' ')
			.replace(/[\u0000-\u001f]/g, ' ')
			.replace(/\s+/g, ' ')
			.replace(/[. ]+$/g, '')
			.trim()
		return (result || 'Anime').slice(0, 120)
	}

	function padEpisodeNumber(value) {
		const number = String(value || '').trim()
		if (!/^\d+$/.test(number)) return number
		if (number.length === 1) return `0${number}`
		return number
	}

	function normalizeEpisodeLabel(value) {
		let result = String(value ?? '').replace(/[\[\]【】()（）]/g, '').replace(/\s+/g, '').trim()
		if (!result) return ''
		result = result.replace(/(?:END|FIN|FINAL|完|合集)$/i, '')
		result = result.replace(/[~～至]/g, '-')
		if (/^\d+(?:-\d+)?$/.test(result)) {
			return result.split('-').map(padEpisodeNumber).join('-')
		}
		const seasonEpisode = result.match(/^S\d{1,2}E(\d{1,4}(?:-\d{1,4})?)$/i)
		if (seasonEpisode) {
			const suffix = seasonEpisode[1].split('-').map(padEpisodeNumber).join('-')
			return result.slice(0, result.indexOf('E') + 1).toUpperCase() + suffix
		}
		const prefixed = result.match(/^(?:EP?|E)(\d{1,4}(?:-\d{1,4})?)$/i)
		if (prefixed) return `E${prefixed[1].split('-').map(padEpisodeNumber).join('-')}`
		return result.toUpperCase()
	}

	function lastMatch(textValue, pattern, group = 1) {
		let found = ''
		for (const match of String(textValue || '').matchAll(pattern)) found = match[group] || match[0] || found
		return found
	}

	function extractEpisodeLabel(...values) {
		const source = values.map(text).filter(Boolean).join(' ')
		if (!source) return ''
		const seasonEpisode = source.match(/\bS\d{1,2}\s*E\s*\d{1,4}(?:\s*[-~～至]\s*\d{1,4})?/i)
		if (seasonEpisode) return normalizeEpisodeLabel(seasonEpisode[0])
		const chapter = lastMatch(source, /(?:^|[\s._\-【\[(（])(?:EP?|E)\s*(\d{1,4}(?:\s*[-~～至]\s*\d{1,4})?)(?=\D|$)/gi)
		if (chapter) return normalizeEpisodeLabel(chapter)
		const chineseChapter = lastMatch(source, /第\s*(\d{1,4}(?:\s*[-~～至]\s*\d{1,4})?)\s*(?:集|話|话|回|期)(?=\D|$)/gi)
		if (chineseChapter) return normalizeEpisodeLabel(chineseChapter)
		const bracket = lastMatch(source, /[\[【(（]\s*(\d{1,4}(?:\s*[-~～至]\s*\d{1,4})?)(?:\s*(?:END|FIN|FINAL|完|合集))?\s*[\]】)）]/gi)
		if (bracket) return normalizeEpisodeLabel(bracket)
		const trailing = lastMatch(source, /(?:^|[\s._\-])((?:\d{1,4})(?:\s*[-~～至]\s*\d{1,4})?)(?!\s*[xX]\s*\d{3,4})(?!\s*[pP](?:\b|$))(?!\s*bit\b)(?=\D|$)/gi)
		return normalizeEpisodeLabel(trailing)
	}

	function isMikanBangumiUrl(value) {
		try {
			const parsed = new URL(value, global.location?.href)
			return parsed.hostname.toLowerCase() === 'mikan.tangbai.cc' && /^\/Home\/Bangumi\/\d+\/?$/i.test(parsed.pathname)
		} catch (error) {
			return false
		}
	}

	function seriesKey(metadata = {}) {
		const explicit = metadata.mikanBangumiUrl || metadata.bangumiId || metadata.seriesKey
		if (explicit) return `mikan:${String(explicit).trim().toLowerCase()}`
		const titleValue = sanitizeSeriesName(metadata.seriesTitle || metadata.animeTitle || metadata.title)
		return `title:${titleValue.toLowerCase()}`
	}

	global.Push115 = global.Push115 || {}
	global.Push115.AnimeUtils = {
		sanitizeSeriesName,
		normalizeEpisodeLabel,
		extractEpisodeLabel,
		isMikanBangumiUrl,
		seriesKey,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
