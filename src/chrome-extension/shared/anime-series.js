;(function (global) {
	'use strict'

	function fromPage(pageUrl, title) {
		try {
			const url = new URL(pageUrl)
			const id = url.pathname.match(/^\/Home\/Bangumi\/([1-9]\d*)\/?$/i)?.[1]
			const name = String(title || '').trim()
			if (url.hostname !== 'mikan.tangbai.cc' || !id || !name) return null
			return { key: `mikan:${id}`, title: name, pageUrl: `${url.origin}/Home/Bangumi/${id}` }
		} catch { return null }
	}

	function normalize(value) {
		const series = fromPage(value?.pageUrl, value?.title)
		return series && series.key === value?.key ? series : null
	}

	function common(intents) {
		const series = normalize(intents[0]?.metadata?.series)
		return series && intents.every(intent => normalize(intent.metadata?.series)?.key === series.key) ? series : null
	}

	function folderName(value) {
		return String(value || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120)
	}

	function needsFlatten(task) {
		return task?.processorProfile === 'anime' && Boolean(task.metadata?.batchId || task.metadata?.animeTarget)
	}

	global.Push115.AnimeSeries = { fromPage, normalize, common, folderName, needsFlatten }
})(globalThis)
