;(function (global) {
	'use strict'
	const content = global.Push115.Content = global.Push115.Content || {}

	function profileFor(siteId) {
		return content.getProfile(siteId) || global.Push115.Config.DEFAULT_SITE_PROFILES[siteId] || {}
	}

	function fromDownload(adapter, download = {}, overrides = {}) {
		if (!adapter?.id) throw new Error('Site Adapter 缺少 id')
		const page = adapter.extractPageMetadata()
		const profile = profileFor(adapter.id)
		const definition = global.Push115.Config.SITE_DEFINITIONS[adapter.id] || {}
		return global.Push115.DownloadIntent.create({
			sourceSite: adapter.id,
			mediaType: definition.mediaType || 'generic',
			url: download.url,
			title: download.title || page.title,
			code: download.code ?? page.code,
			metadata: { ...page, ...(download.metadata || {}) },
			savePathCid: profile.defaultSavePathCid,
			processorProfile: adapter.getDefaultProcessorProfile(),
			...overrides,
		})
	}

	function fromDownloads(adapter, downloads = [], overrides = {}) {
		return downloads.map(download => fromDownload(adapter, download, overrides))
	}

	function confirm(adapter, downloads = [], options = {}) {
		const profile = profileFor(adapter.id)
		return content.ConfirmModal.show({
			intents: fromDownloads(adapter, downloads),
			sourceSite: adapter.id,
			defaultProcessorProfile: adapter.getDefaultProcessorProfile(),
			defaultSavePathCid: profile.defaultSavePathCid,
			batchConcurrency: profile.batchConcurrency || 2,
			...options,
		})
	}

	content.IntentFactory = { fromDownload, fromDownloads, confirm }
})(globalThis)
