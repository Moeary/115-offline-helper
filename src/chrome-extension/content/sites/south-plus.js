;(function (global) {
	'use strict'
	const adapters = global.Push115.SiteAdapters = global.Push115.SiteAdapters || {}
	const SITE_ID = 'southplus'
	const DOWNLOAD_SELECTOR = 'a[href^="ed2k:"]'
	const THREAD_CONTENT_SELECTOR = [
		'.tpc_content',
		'.tpc_content_post',
		'.tpc_content_postbody',
		'.tpc_content_body',
		'.postbody',
		'.post-content',
		'article',
	].join(', ')
	const TOOLBAR_ID = 'push115-southplus-toolbar'
	const LIST_ID = 'push115-southplus-resource-list'
	const TEXT_SOURCE_SELECTOR = '[data-southplus-ed2k-source]'
	const TEXT_NODE = 3
	const SHOW_TEXT = 4
	const IGNORED_TAGS = new Set(['script', 'style', 'noscript', 'template'])
	const ED2K_TEXT_PATTERN = /ed2k\s*:\s*\/\/\s*\|\s*file\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*\//gi
	const CODE_TOKEN = /(?:^|[^A-Z0-9])((?:FC2[-_.\s]?(?:PPV[-_.\s]?)?\d{5,7}|[A-Z]{2,6}[-_.\s]?\d{2,5}(?:[-_.\s]?[A-Z])?))(?=$|[^A-Z0-9])/gi
	// normalizeCode intentionally accepts a broad alphanumeric shape. South Plus
	// titles also contain generic page/file vocabulary, so do not promote those
	// known words to a JAV page code.
	const NON_CODE_PREFIXES = new Set([
		'AV', 'COM', 'ED2K', 'EP', 'FILE', 'FULL', 'H264', 'HD', 'HEVC', 'HTTP', 'HTTPS', 'JAV',
		'KEYWORD', 'LADA', 'MKV', 'MP4', 'PAGE', 'PART', 'PLUS', 'PNG', 'READ', 'RESTORE', 'RESTORED',
		'SAMPLE', 'SEASON', 'SOUTH', 'TEST', 'THREAD', 'TITLE', 'VIDEO', 'WEB', 'WWW',
	])

	function pageLocation() {
		return global.location || {}
	}

	function matches(currentLocation = pageLocation()) {
		const protocol = String(currentLocation.protocol || '').toLowerCase()
		const hostname = String(currentLocation.hostname || '').toLowerCase()
		const pathname = String(currentLocation.pathname || '').toLowerCase().replace(/\/+$/, '')
		return /^https?:$/.test(protocol)
			&& global.Push115.Config.isSouthPlusHostname(hostname)
			&& pathname === '/read.php'
	}

	function decodeFileName(value) {
		try { return decodeURIComponent(String(value || '')) } catch (error) { return String(value || '') }
	}

	function extractEd2kFileName(url) {
		const match = String(url || '').trim().match(/^ed2k:\/\/\|file\|([^|]*)\|/i)
		return match ? decodeFileName(match[1]).trim() : ''
	}

	function decodeHtmlEntities(value) {
		const named = {
			amp: '&',
			apos: "'",
			gt: '>',
			lt: '<',
			nbsp: ' ',
			quot: '"',
		}
		return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, name) => {
			const normalizedName = String(name || '').toLowerCase()
			if (normalizedName === 'nbsp') return ' '
			if (normalizedName[0] !== '#') return named[normalizedName] || entity
			const radix = normalizedName[1].toLowerCase() === 'x' ? 16 : 10
			const digits = normalizedName.slice(radix === 16 ? 2 : 1)
			const codePoint = Number.parseInt(digits, radix)
			if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
			try { return String.fromCodePoint(codePoint) } catch (error) { return entity }
		})
	}

	function elementTagName(element) {
		return String(element?.tagName || element?.nodeName || '').toLowerCase()
	}

	function hasExtensionMarker(element) {
		if (!element) return false
		const id = String(element.id || '').toLowerCase()
		if (id === TOOLBAR_ID || id.startsWith('push115-')) return true
		const className = typeof element.className === 'string' ? element.className : ''
		if (/\bpush115(?:-|_)/i.test(className)) return true
		return Boolean(element.dataset?.push115Site || element.getAttribute?.('data-push115-site'))
	}

	function isIgnoredElement(element) {
		return IGNORED_TAGS.has(elementTagName(element)) || hasExtensionMarker(element)
	}

	function isIgnoredTextNode(node) {
		let current = node?.parentElement || node?.parentNode || null
		while (current) {
			if (elementTagName(current) === 'a' && global.Push115.DownloadIntent.isDownloadUrl(anchorUrl(current))) return true
			if (isIgnoredElement(current)) return true
			current = current.parentElement || current.parentNode || null
		}
		return false
	}

	function queryAll(root, selector) {
		try { return [...root?.querySelectorAll?.(selector) || []] } catch (error) { return [] }
	}

	function threadContentRoots() {
		const document = global.document
		const roots = []
		for (const candidate of queryAll(document, THREAD_CONTENT_SELECTOR)) {
			if (!candidate || isIgnoredElement(candidate)) continue
			if (roots.some(root => root === candidate || root.contains?.(candidate))) continue
			roots.push(candidate)
		}
		if (roots.length) return roots
		const fallback = document?.body || document?.documentElement || null
		return fallback && !isIgnoredElement(fallback) ? [fallback] : []
	}

	function collectTextNodes(root) {
		const nodes = []
		const document = global.document
		if (typeof document?.createTreeWalker === 'function') {
			const walker = document.createTreeWalker(root, global.NodeFilter?.SHOW_TEXT || SHOW_TEXT)
			let node = walker.nextNode()
			while (node) {
				if (node.nodeType === TEXT_NODE && !isIgnoredTextNode(node)) nodes.push(node)
				node = walker.nextNode()
			}
			return nodes
		}
		const visit = node => {
			if (!node || isIgnoredTextNode(node)) return
			if (node.nodeType === TEXT_NODE) {
				nodes.push(node)
				return
			}
			for (const child of node.childNodes || []) visit(child)
		}
		visit(root)
		return nodes
	}

	function textNodeValue(node) {
		return decodeHtmlEntities(node?.nodeValue ?? node?.textContent ?? '').replace(/\u00a0/g, ' ')
	}

	function collectTextSegments(root) {
		const segments = []
		let offset = 0
		for (const node of collectTextNodes(root)) {
			const text = textNodeValue(node)
			if (!text) continue
			if (segments.length) offset += 1
			const start = offset
			offset += text.length
			segments.push({ node, root, start, end: offset, text })
		}
		return { segments, text: segments.map(segment => segment.text).join('\n') }
	}

	function textCarrier(node, root) {
		let carrier = node?.parentElement || node?.parentNode || null
		while (carrier && isIgnoredElement(carrier)) carrier = carrier.parentElement || carrier.parentNode || null
		const body = global.document?.body
		const documentElement = global.document?.documentElement
		if (!carrier) return root || null
		if ((carrier === body || carrier === documentElement) && root && root !== carrier) return root
		return carrier
	}

	function segmentForOffset(segments, offset) {
		return segments.find(segment => offset >= segment.start && offset < segment.end) || segments[0] || null
	}

	function normalizeTextEd2k(match) {
		const fileField = String(match?.[1] || '').replace(/\s+/g, ' ').trim()
		const sizeField = String(match?.[2] || '').replace(/\s+/g, '').trim()
		const hashField = String(match?.[3] || '').replace(/\s+/g, '').trim()
		if (!fileField || !sizeField || !hashField) return null
		const url = `ed2k://|file|${fileField}|${sizeField}|${hashField}|/`
		return {
			url,
			fileName: extractEd2kFileName(url),
		}
	}

	function isReliableCode(code) {
		const prefix = String(code || '').split('-')[0]
		return prefix === 'FC2'
			|| (/^[A-Z]{3,6}$/.test(prefix) && !NON_CODE_PREFIXES.has(prefix))
	}

	function extractCode(values) {
		const candidates = Array.isArray(values) ? values : [values]
		for (const value of candidates) {
			for (const match of String(value || '').matchAll(CODE_TOKEN)) {
				const code = global.Push115.DownloadIntent.normalizeCode(match[1])
				if (code && isReliableCode(code)) return code
			}
		}
		return ''
	}

	function pageHeading() {
		return global.document?.querySelector('h1, h2, h3, .subject, .f14') || null
	}

	function extractPageMetadata() {
		const heading = pageHeading()
		const meta = global.document?.querySelector('meta[property="og:title"]')
		const metaTitle = meta?.content || meta?.getAttribute?.('content') || ''
		const title = String(metaTitle || heading?.textContent || global.document?.title || '').trim()
		const code = extractCode([heading?.textContent, title])
		return {
			title,
			code,
			pageCode: code,
			pageUrl: String(pageLocation().href || '').trim(),
		}
	}

	function addDiscoveredDownload(unique, page, { element, sourceElement, url, title, linkText, fileName, code, sourceType }) {
		if (!global.Push115.DownloadIntent.isDownloadUrl(url)) return
		const key = global.Push115.DownloadIntent.dedupeKey(url)
		if (unique.has(key)) return
		unique.set(key, {
			key,
			element,
			sourceElement,
			url,
			title: title || fileName || linkText || page.title,
			code: code || extractCode([fileName, linkText, page.title]),
			metadata: {
				...page,
				fileName,
				ed2kFileName: fileName,
				linkText,
				...(sourceType ? { sourceType } : {}),
			},
		})
	}

	function anchorUrl(anchor) {
		const attribute = anchor?.getAttribute?.('href') || ''
		return String(anchor?.href || attribute).trim()
	}

	function discoverDownloads() {
		const page = extractPageMetadata()
		const unique = new Map()
		for (const anchor of global.document?.querySelectorAll(DOWNLOAD_SELECTOR) || []) {
			const url = anchorUrl(anchor)
			if (!global.Push115.DownloadIntent.isDownloadUrl(url)) continue
			const fileName = extractEd2kFileName(url)
			const titleAttribute = String(anchor.getAttribute?.('title') || '').trim()
			const anchorText = String(anchor.textContent || '').trim()
			const linkText = titleAttribute || anchorText
			addDiscoveredDownload(unique, page, {
				element: anchor,
				sourceElement: anchor,
				url,
				fileName,
				linkText,
				code: extractCode([fileName, anchorText, titleAttribute, page.title]),
			})
		}
		for (const root of threadContentRoots()) {
			const { segments, text } = collectTextSegments(root)
			for (const match of text.matchAll(ED2K_TEXT_PATTERN)) {
				const normalized = normalizeTextEd2k(match)
				if (!normalized) continue
				const segment = segmentForOffset(segments, match.index || 0)
				const sourceElement = textCarrier(segment?.node, root)
				if (!sourceElement) continue
				addDiscoveredDownload(unique, page, {
					element: sourceElement,
					sourceElement,
					url: normalized.url,
					fileName: normalized.fileName,
					linkText: String(match[0] || '').trim(),
					code: extractCode([normalized.fileName, match[0], page.title]),
					sourceType: 'text',
				})
			}
		}
		return [...unique.values()]
	}

	function restoreTextSources() {
		for (const wrapper of queryAll(global.document, TEXT_SOURCE_SELECTOR)) {
			const parent = wrapper.parentNode || wrapper.parentElement
			if (!parent) continue
			const children = [...wrapper.childNodes || []]
			for (const child of children) parent.insertBefore(child, wrapper)
			if (wrapper.remove) wrapper.remove()
			else parent.removeChild?.(wrapper)
		}
	}

	function getProfile() {
		return global.Push115.Content?.getProfile?.(SITE_ID)
			|| global.Push115.Config.DEFAULT_SITE_PROFILES[SITE_ID]
			|| {}
	}

	function getDefaultProcessorProfile() {
		return getProfile().defaultProcessorProfile || 'jav'
	}

	function showToast(type, message) {
		global.Push115.Content?.Feedback?.toast?.(type, message)
	}

	async function recordDownloads(downloads = []) {
		try {
			const intents = global.Push115.Content.IntentFactory.fromDownloads(adapters[SITE_ID], downloads)
			const result = await global.Push115.Messaging.send('RECORD_INTENTS', { intents })
			const recorded = Number(result?.recorded) || 0
			const duplicate = Number(result?.duplicate) || 0
			if (recorded > 0) {
				showToast('success', `记录完成：新增 ${recorded} 项${duplicate ? `，重复 ${duplicate} 项` : ''}`)
			} else if (duplicate > 0) {
				showToast('warning', `记录重复：${duplicate} 项已存在`)
			} else {
				showToast('info', '没有新增记录')
			}
			return result
		} catch (error) {
			showToast('error', `记录失败：${error?.message || error}`)
			return null
		}
	}

	function selectedDownloads() {
		const selected = new Set(
			[...global.document.querySelectorAll(`.push115-row-check[data-push115-site="${SITE_ID}"]`)]
				.filter(input => input.checked)
				.map(input => input.dataset.key),
		)
		return discoverDownloads().filter(download => selected.has(download.key))
	}

	function addToolbar(downloads, profile) {
		const existing = global.document.getElementById?.(TOOLBAR_ID)
		if (existing) {
			const hint = existing.querySelector?.('.push115-toolbar-hint')
			if (hint) hint.textContent = `已识别 ${downloads.length} 项（按链接去重）`
			return
		}
		const toolbar = global.document.createElement('div')
		toolbar.id = TOOLBAR_ID
		toolbar.className = 'push115-site-toolbar'
		toolbar.dataset.push115Site = SITE_ID
		const selectAll = global.document.createElement('button')
		selectAll.type = 'button'
		selectAll.className = 'push115-batch-btn push115-secondary'
		selectAll.textContent = '全选'
		const selected = global.document.createElement('button')
		selected.type = 'button'
		selected.className = 'push115-batch-btn'
		selected.textContent = '发送选中到115'
		const recordSelected = global.document.createElement('button')
		recordSelected.type = 'button'
		recordSelected.className = 'push115-batch-btn'
		recordSelected.textContent = '记录选中'
		const hint = global.document.createElement('span')
		hint.className = 'push115-toolbar-hint'
		hint.textContent = `已识别 ${downloads.length} 项（按链接去重）`
		selectAll.addEventListener('click', () => {
			const boxes = [...global.document.querySelectorAll(`.push115-row-check[data-push115-site="${SITE_ID}"]`)]
			const shouldCheck = boxes.some(box => !box.checked)
			boxes.forEach(box => { box.checked = shouldCheck })
			selectAll.textContent = shouldCheck ? '取消全选' : '全选'
		})
		selected.addEventListener('click', () => {
			const items = selectedDownloads()
			if (items.length) void global.Push115.Content?.IntentFactory?.confirm?.(adapters[SITE_ID], items)
			else global.Push115.Content?.Feedback?.toast?.('warning', '请先选择资源')
		})
		recordSelected.addEventListener('click', () => {
			const items = selectedDownloads()
			if (items.length) void recordDownloads(items)
			else showToast('warning', '请先选择资源')
		})
		toolbar.append(selectAll, selected)
		if (profile.recordButton !== false) toolbar.appendChild(recordSelected)
		toolbar.appendChild(hint)
		const firstAnchor = downloads[0]?.sourceElement
		const block = firstAnchor?.closest?.('table, article, li, .tpc_content, .tpc_content_post')
		if (block?.parentElement) block.parentElement.insertBefore(toolbar, block)
		else if (global.document.body) global.document.body.insertBefore(toolbar, global.document.body.firstChild)
	}

	function addResourceList(downloads, profile) {
		const existing = global.document.getElementById?.(LIST_ID)
		if (existing) {
			const hint = existing.querySelector?.('.push115-resource-list-hint')
			if (hint) hint.textContent = `共 ${downloads.length} 项`
			return
		}
		const list = global.document.createElement('section')
		list.id = LIST_ID
		list.className = 'push115-resource-list'
		list.dataset.push115Site = SITE_ID
		const heading = global.document.createElement('div')
		heading.className = 'push115-resource-list-heading'
		const title = global.document.createElement('strong')
		title.textContent = 'South Plus ED2K 资源列表'
		const hint = global.document.createElement('span')
		hint.className = 'push115-resource-list-hint'
		hint.textContent = `共 ${downloads.length} 项`
		heading.append(title, hint)
		const rows = global.document.createElement('div')
		rows.className = 'push115-resource-list-rows'
		for (const download of downloads) {
			const row = global.document.createElement('div')
			row.className = 'push115-resource-row'
			row.dataset.push115Site = SITE_ID
			row.dataset.key = download.key
			if (profile.batchSelection !== false) {
				const checkbox = global.document.createElement('input')
				checkbox.type = 'checkbox'
				checkbox.className = 'push115-row-check'
				checkbox.dataset.push115Site = SITE_ID
				checkbox.dataset.key = download.key
				checkbox.title = '选择资源'
				checkbox.setAttribute?.('aria-label', `选择 ${download.title || download.metadata?.fileName || '资源'}`)
				row.appendChild(checkbox)
			}
			const name = global.document.createElement('span')
			name.className = 'push115-resource-name'
			name.textContent = download.title || download.metadata?.fileName || download.url
			name.title = download.url
			row.appendChild(name)
			if (profile.inlineSendButton !== false) {
				const send = global.document.createElement('button')
				send.type = 'button'
				send.className = 'push115-inline-btn push115-resource-btn'
				send.dataset.key = download.key
				send.dataset.push115Site = SITE_ID
				send.setAttribute?.('aria-label', `发送 ${download.title || download.metadata?.fileName || '资源'} 到115`)
				send.textContent = '发送到115'
				send.addEventListener('click', event => {
					event.preventDefault()
					event.stopPropagation()
					void global.Push115.Content?.IntentFactory?.confirm?.(adapters[SITE_ID], [download])
				})
				row.appendChild(send)
			}
			if (profile.recordButton !== false) {
				const record = global.document.createElement('button')
				record.type = 'button'
				record.className = 'push115-inline-btn push115-record-btn push115-resource-btn'
				record.dataset.key = download.key
				record.dataset.push115Site = SITE_ID
				record.setAttribute?.('aria-label', `记录 ${download.title || download.metadata?.fileName || '资源'}`)
				record.textContent = '记录'
				record.addEventListener('click', event => {
					event.preventDefault()
					event.stopPropagation()
					void recordDownloads([download])
				})
				row.appendChild(record)
			}
			rows.appendChild(row)
		}
		list.append(heading, rows)
		const source = downloads[0]?.sourceElement
		const block = source?.closest?.('table, article, li, .tpc_content, .tpc_content_post')
		if (block?.parentElement) block.parentElement.insertBefore(list, block)
		else if (global.document.body) global.document.body.insertBefore(list, global.document.body.firstChild || null)
	}

	function enhancePage() {
		const profile = getProfile()
		restoreTextSources()
		const downloads = discoverDownloads()
		if (!downloads.length) return
		if (profile.batchSelection !== false) addToolbar(downloads, profile)
		addResourceList(downloads, profile)
	}

	adapters[SITE_ID] = {
		id: SITE_ID,
		matches,
		extractPageMetadata,
		discoverDownloads,
		enhancePage,
		getDefaultProcessorProfile,
		extractEd2kFileName,
		extractCode,
		recordDownloads,
	}
})(globalThis)
