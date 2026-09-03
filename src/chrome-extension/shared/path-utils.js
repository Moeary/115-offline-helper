;(function (global) {
	'use strict'

	function normalizeCid(value) {
		const cid = String(value ?? '').trim()
		return /^\d+$/.test(cid) ? cid : ''
	}

	function parsePathLine(line) {
		const raw = String(line || '').trim()
		if (!raw) return null
		const idx = raw.lastIndexOf(':')
		if (idx === -1) {
			const cidOnly = normalizeCid(raw)
			return cidOnly ? { name: '', cid: cidOnly } : null
		}
		const name = raw.slice(0, idx).trim()
		const cid = normalizeCid(raw.slice(idx + 1))
		return cid ? { name, cid } : null
	}

	function parsePathList(rawText) {
		const result = []
		const seen = new Set()
		for (const line of String(rawText || '').split('\n')) {
			const item = parsePathLine(line)
			if (!item || seen.has(item.cid)) continue
			seen.add(item.cid)
			result.push(item)
		}
		return result
	}

	function buildPathOptions(rawList, rootLabel = '根目录') {
		const parsed = parsePathList(rawList)
		return parsed.some(item => item.cid === '0') ? parsed : [{ name: rootLabel, cid: '0' }, ...parsed]
	}

	function findPathByCid(rawList, cid) {
		const target = normalizeCid(cid) || '0'
		return buildPathOptions(rawList).find(item => item.cid === target) || null
	}

	function formatPathLabel(item, rootLabel = '根目录') {
		if (!item || item.cid === '0') return rootLabel
		return item.name || `CID:${item.cid}`
	}

	global.Push115 = global.Push115 || {}
	global.Push115.PathUtils = {
		normalizeCid,
		parsePathList,
		buildPathOptions,
		findPathByCid,
		getDisplayName: formatPathLabel,
		formatPathLabel,
	}
})(typeof globalThis !== 'undefined' ? globalThis : self)
