;(function (global) {
	'use strict'
	const adapters = global.Push115.SiteAdapters = global.Push115.SiteAdapters || {}
	const SITE_ID = 'mikan'
	const animeUtils = global.Push115.AnimeUtils

	function matches(currentLocation = location) {
		return currentLocation.hostname === 'mikan.tangbai.cc'
	}

	function extractPageMetadata() {
		const heading = document.querySelector('.bangumi-title, .bangumi-info h1, .bangumi-info .title, main h1, h1')
		const title = (heading?.textContent || document.querySelector('meta[property="og:title"]')?.content || document.title)
			.replace(/\s*[-|｜]\s*Mikan Project.*$/i, '')
			.trim()
		const bangumiId = location.pathname.match(/\/Bangumi\/(\d+)/i)?.[1] || ''
		const detail = Boolean(animeUtils?.isMikanBangumiUrl(location.href))
		const canonicalUrl = detail ? `${location.origin}${location.pathname.replace(/\/+$/, '')}` : ''
		return {
			title,
			seriesTitle: title,
			animeTitle: title,
			code: '',
			pageCode: '',
			pageUrl: location.href,
			mikanBangumiUrl: canonicalUrl,
			mikanDetail: detail,
			bangumiId,
			seriesKey: animeUtils?.seriesKey({ mikanBangumiUrl: canonicalUrl, bangumiId, seriesTitle: title }) || '',
		}
	}

	function magnetFrom(element) {
		for (const attribute of ['href', 'data-clipboard-text', 'data-magnet', 'data-magnet-link', 'data-url']) {
			const value = element.getAttribute(attribute)
			if (/^magnet:/i.test(value || '')) return value.trim()
		}
		return (element.getAttribute('onclick') || '').match(/magnet:\?[^'"\s)]+/i)?.[0] || ''
	}

	function discoverDownloads() {
		// Mikan 番组详情页核对过的稳定结构：table.table-striped（部分主题为
		// table.table-stripped）tbody tr；标题在 .magnet-link-wrap 或资源链接，
		// 磁链由 a.js-magnet/data-clipboard-text 或 input.js-episode-select[data-magnet] 提供。
		const selector = [
			'table.table-striped tbody tr a.js-magnet',
			'table.table-stripped tbody tr a.js-magnet',
			'a.js-magnet',
			'a[href^="magnet:"]',
			'[data-clipboard-text]',
			'input.js-episode-select[data-magnet]',
			'input[data-magnet]',
			'[data-magnet-link]',
			'[data-url^="magnet:"]',
			'[onclick*="magnet:"]',
		].join(', ')
		const unique = new Map()
		for (const sourceElement of document.querySelectorAll(selector)) {
			const url = magnetFrom(sourceElement)
			const btih = global.Push115.DownloadIntent.extractBtih(url)
			if (!url || !btih) continue
			const row = sourceElement.closest('table.table-striped tbody tr, table.table-stripped tbody tr, tr, .episode-item, .torrent-item, article') || sourceElement.parentElement
			const titleElement = row?.querySelector('.magnet-link-wrap, .an-text, .episode-title, .torrent-title, a[target="_blank"], td:nth-child(1) a, td:nth-child(2) a')
			const title = (titleElement?.textContent || sourceElement.getAttribute('title') || row?.textContent || document.title)
				.replace(/\s*\[复制磁(?:连|链)\]\s*$/i, '')
				.trim()
			const page = extractPageMetadata()
			const existing = unique.get(btih)
			if (!existing) {
				unique.set(btih, {
					key: btih,
					btih,
					element: row,
					sourceElement,
					url,
					title,
					metadata: {
						btih,
						episode: animeUtils?.extractEpisodeLabel(title),
						seriesTitle: page.seriesTitle || page.title,
						animeTitle: page.animeTitle || page.title,
						mikanDetail: page.mikanDetail === true,
						mikanBangumiUrl: page.mikanBangumiUrl || '',
						bangumiId: page.bangumiId || '',
						seriesKey: page.seriesKey || '',
					},
				})
			} else if (existing.sourceElement.matches('input') && !sourceElement.matches('input')) {
				existing.sourceElement = sourceElement
			}
		}
		return [...unique.values()]
	}

	function getDefaultProcessorProfile() {
		const configured = global.Push115.Content.getProfile(SITE_ID)?.defaultProcessorProfile || 'anime_mikan'
		// The dedicated organizer is meaningful only on a concrete /Home/Bangumi/N
		// page.  Mikan search/list pages retain the conservative Anime profile.
		if (configured === 'anime_mikan' && !animeUtils?.isMikanBangumiUrl(location.href)) return 'anime'
		return configured
	}

	function selectedDownloads() {
		const selected = new Set([...document.querySelectorAll('.push115-row-check[data-push115-site="mikan"]:checked')].map(input => input.dataset.key))
		return discoverDownloads().filter(download => selected.has(download.btih))
	}

	function addRowControls(download) {
		const profile = global.Push115.Content.getProfile(SITE_ID)
		if (profile.batchSelection !== false && !download.element?.querySelector(`.push115-row-check[data-key="${download.btih}"]`)) {
			const nativeCheckbox = download.element?.querySelector('input.js-episode-select[data-magnet], input[data-magnet]')
			const checkbox = nativeCheckbox || document.createElement('input')
			checkbox.type = 'checkbox'
			checkbox.classList.add('push115-row-check')
			checkbox.dataset.push115Site = SITE_ID
			checkbox.dataset.key = download.btih
			if (!nativeCheckbox) checkbox.title = '选择资源'
			if (nativeCheckbox) checkbox.dataset.push115Native = 'true'
			if (!checkbox.isConnected) {
				const cell = download.element?.matches('tr') ? download.element.querySelector('td') : download.element
				cell?.insertBefore(checkbox, cell.firstChild)
			}
		}
		const inlineButtonExists = download.element?.querySelector(`.push115-inline-btn[data-key="${download.btih}"]`) ||
			download.sourceElement.parentElement?.querySelector(`.push115-inline-btn[data-key="${download.btih}"]`)
		if (profile.inlineSendButton !== false && !inlineButtonExists) {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = 'push115-inline-btn'
			button.dataset.push115Site = SITE_ID
			button.dataset.key = download.btih
			button.textContent = '发送到115'
			button.addEventListener('click', event => {
				event.preventDefault()
				event.stopPropagation()
				void global.Push115.Content.IntentFactory.confirm(adapters.mikan, [download])
			})
			download.sourceElement.insertAdjacentElement('afterend', button)
		}
	}

	function addToolbar(downloads) {
		const existing = document.getElementById('push115-mikan-toolbar')
		if (existing) {
			existing.querySelector('.push115-toolbar-hint').textContent = `已识别 ${downloads.length} 项（按 BTIH 去重）`
			return
		}
		const toolbar = document.createElement('div')
		toolbar.id = 'push115-mikan-toolbar'
		toolbar.className = 'push115-site-toolbar'
		toolbar.dataset.push115Site = SITE_ID
		const selectAll = document.createElement('button')
		selectAll.type = 'button'
		selectAll.className = 'push115-batch-btn push115-secondary'
		selectAll.textContent = '全选'
		const selected = document.createElement('button')
		selected.type = 'button'
		selected.className = 'push115-batch-btn'
		selected.textContent = '发送选中到115'
		const all = document.createElement('button')
		all.type = 'button'
		all.className = 'push115-batch-btn'
		all.textContent = '全部推送到115'
		const hint = document.createElement('span')
		hint.className = 'push115-toolbar-hint'
		hint.textContent = `已识别 ${downloads.length} 项（按 BTIH 去重）`
		selectAll.addEventListener('click', () => {
			const boxes = [...document.querySelectorAll('.push115-row-check[data-push115-site="mikan"]')]
			const shouldCheck = boxes.some(box => !box.checked)
			boxes.forEach(box => { box.checked = shouldCheck })
			selectAll.textContent = shouldCheck ? '取消全选' : '全选'
		})
		selected.addEventListener('click', () => {
			const items = selectedDownloads()
			if (items.length) void global.Push115.Content.IntentFactory.confirm(adapters.mikan, items)
			else global.Push115.Content.Feedback.toast('warning', '请先选择资源')
		})
		all.addEventListener('click', () => void global.Push115.Content.IntentFactory.confirm(adapters.mikan, discoverDownloads()))
		toolbar.append(selectAll, selected, all, hint)
		const table = downloads[0]?.element?.closest('table')
		if (table?.parentElement) table.parentElement.insertBefore(toolbar, table)
		else document.body.insertBefore(toolbar, document.body.firstChild)
	}

	function enhancePage() {
		const profile = global.Push115.Content.getProfile(SITE_ID)
		const downloads = discoverDownloads()
		downloads.forEach(addRowControls)
		if (profile.batchSelection !== false && downloads.length) addToolbar(downloads)
	}

	adapters.mikan = { id: SITE_ID, matches, extractPageMetadata, discoverDownloads, enhancePage, getDefaultProcessorProfile }
})(globalThis)
