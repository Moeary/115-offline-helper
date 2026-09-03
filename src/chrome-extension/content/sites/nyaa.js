;(function (global) {
	'use strict'
	const adapters = global.Push115.SiteAdapters = global.Push115.SiteAdapters || {}

	function createNyaaFamilyAdapter(siteId, hostname, fallbackProfile) {
		function matches(currentLocation = location) {
			return currentLocation.hostname === hostname
		}

		function extractPageMetadata() {
			return {
				title: (document.querySelector('meta[property="og:title"]')?.content || document.title).trim(),
				code: '',
				pageCode: '',
				pageUrl: location.href,
				query: new URL(location.href).searchParams.get('q') || '',
			}
		}

		function discoverDownloads() {
			const unique = new Map()
			for (const row of document.querySelectorAll('table.torrent-list > tbody > tr')) {
				const magnet = row.querySelector('td:nth-child(3) a[href^="magnet:"]') || row.querySelector('a[href^="magnet:"]')
				if (!magnet) continue
				const btih = global.Push115.DownloadIntent.extractBtih(magnet.href)
				if (!btih || unique.has(btih)) continue
				const titleLink = row.querySelector('td:nth-child(2) a[href^="/view/"], td:nth-child(2) a[title]')
				const title = (titleLink?.getAttribute('title') || titleLink?.textContent || row.cells?.[1]?.textContent || '').trim()
				unique.set(btih, {
					key: btih,
					btih,
					element: row,
					sourceElement: magnet,
					actionCell: magnet.closest('td'),
					url: magnet.href,
					title,
					metadata: { btih, detailUrl: titleLink?.href || '' },
				})
			}
			return [...unique.values()]
		}

		function getDefaultProcessorProfile() {
			return global.Push115.Content.getProfile(siteId)?.defaultProcessorProfile || fallbackProfile
		}

		function selectedDownloads() {
			const selected = new Set([...document.querySelectorAll(`.push115-row-check[data-push115-site="${siteId}"]:checked`)].map(input => input.dataset.key))
			return discoverDownloads().filter(download => selected.has(download.btih))
		}

		function addRowControls(download) {
			const profile = global.Push115.Content.getProfile(siteId)
			if (profile.batchSelection !== false && !download.actionCell?.querySelector(`.push115-row-check[data-key="${download.btih}"]`)) {
				const checkbox = document.createElement('input')
				checkbox.type = 'checkbox'
				checkbox.className = 'push115-row-check'
				checkbox.dataset.push115Site = siteId
				checkbox.dataset.key = download.btih
				checkbox.title = '选择资源'
				download.actionCell?.insertBefore(checkbox, download.actionCell.firstChild)
			}
			if (profile.inlineSendButton !== false && !download.actionCell?.querySelector(`.push115-inline-btn[data-key="${download.btih}"]`)) {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'push115-inline-btn'
				button.dataset.push115Site = siteId
				button.dataset.key = download.btih
				button.textContent = '发送到115'
				button.addEventListener('click', event => {
					event.preventDefault()
					event.stopPropagation()
					void global.Push115.Content.IntentFactory.confirm(adapters[siteId], [download])
				})
				download.sourceElement.insertAdjacentElement('afterend', button)
			}
		}

		function addToolbar(downloads) {
			const toolbarId = `push115-${siteId}-toolbar`
			const existing = document.getElementById(toolbarId)
			if (existing) {
				existing.querySelector('.push115-toolbar-hint').textContent = `已识别 ${downloads.length} 项`
				return
			}
			const toolbar = document.createElement('div')
			toolbar.id = toolbarId
			toolbar.className = 'push115-site-toolbar'
			toolbar.dataset.push115Site = siteId
			const selectAll = document.createElement('button')
			selectAll.type = 'button'
			selectAll.className = 'push115-batch-btn push115-secondary'
			selectAll.textContent = '全选'
			const selected = document.createElement('button')
			selected.type = 'button'
			selected.className = 'push115-batch-btn'
			selected.textContent = '发送选中到115'
			const hint = document.createElement('span')
			hint.className = 'push115-toolbar-hint'
			hint.textContent = `已识别 ${downloads.length} 项`
			selectAll.addEventListener('click', () => {
				const boxes = [...document.querySelectorAll(`.push115-row-check[data-push115-site="${siteId}"]`)]
				const shouldCheck = boxes.some(box => !box.checked)
				boxes.forEach(box => { box.checked = shouldCheck })
				selectAll.textContent = shouldCheck ? '取消全选' : '全选'
			})
			selected.addEventListener('click', () => {
				const items = selectedDownloads()
				if (items.length) void global.Push115.Content.IntentFactory.confirm(adapters[siteId], items)
				else global.Push115.Content.Feedback.toast('warning', '请先选择资源')
			})
			toolbar.append(selectAll, selected, hint)
			const table = downloads[0]?.element?.closest('table.torrent-list')
			if (table?.parentElement) table.parentElement.insertBefore(toolbar, table)
		}

		function enhancePage() {
			const profile = global.Push115.Content.getProfile(siteId)
			const downloads = discoverDownloads()
			downloads.forEach(addRowControls)
			if (profile.batchSelection !== false && downloads.length) addToolbar(downloads)
		}

		return { id: siteId, matches, extractPageMetadata, discoverDownloads, enhancePage, getDefaultProcessorProfile }
	}

	adapters.nyaa = createNyaaFamilyAdapter('nyaa', 'nyaa.si', 'anime')
	adapters.sukebei = createNyaaFamilyAdapter('sukebei', 'sukebei.nyaa.si', 'generic')
})(globalThis)
