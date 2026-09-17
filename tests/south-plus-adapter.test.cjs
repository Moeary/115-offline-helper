const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')

function loadRuntime(document, location) {
	const context = vm.createContext({ console, URL, document, location })
	for (const relative of ['shared/config.js', 'shared/download-intent.js', 'content/sites/south-plus.js']) {
		vm.runInContext(fs.readFileSync(path.join(extension, relative), 'utf8'), context, { filename: relative })
	}
	return context.Push115
}

function makeAnchor(url, text = '', title = '') {
	return {
		tagName: 'A',
		href: url,
		textContent: text,
		dataset: {},
		getAttribute(name) {
			if (name === 'href') return url
			if (name === 'title') return title
			return ''
		},
	}
}

function makeTextNode(value, parent = null) {
	return {
		nodeType: 3,
		nodeName: '#text',
		nodeValue: value,
		textContent: value,
		parentNode: parent,
		parentElement: parent,
	}
}

function makeElement({ tagName = 'div', className = '', id = '', children = [], text = '' } = {}) {
	const element = {
		nodeType: 1,
		nodeName: tagName.toUpperCase(),
		tagName: tagName.toUpperCase(),
		className,
		id,
		dataset: {},
		childNodes: [],
		adjacentElements: [],
		parentNode: null,
		parentElement: null,
		appendChild(child) {
			child.parentNode = element
			child.parentElement = element
			element.childNodes.push(child)
			return child
		},
		contains(candidate) {
			return candidate === element || element.childNodes.some(child => child === candidate || child.contains?.(candidate))
		},
		insertBefore(child, reference) {
			const oldIndex = element.childNodes.indexOf(child)
			if (oldIndex >= 0) element.childNodes.splice(oldIndex, 1)
			const index = reference ? element.childNodes.indexOf(reference) : -1
			element.childNodes.splice(index >= 0 ? index : element.childNodes.length, 0, child)
			child.parentNode = element
			child.parentElement = element
			return child
		},
		insertAdjacentElement(position, child) {
			element.adjacentElements.push({ position, element: child })
			if (!element.parentElement) return child
			if (position === 'beforebegin') element.parentElement.insertBefore(child, element)
			if (position === 'afterend') {
				const siblings = element.parentElement.childNodes
				const next = siblings[siblings.indexOf(element) + 1] || null
				element.parentElement.insertBefore(child, next)
			}
			return child
		},
		append(...items) {
			items.forEach(item => element.appendChild(item))
		},
		addEventListener() {},
		setAttribute(name, value) {
			if (name === 'data-southplus-ed2k-source') element.dataset.southplusEd2kSource = String(value)
		},
		closest(selector) {
			if (selector === '[data-southplus-ed2k-source]' && element.dataset.southplusEd2kSource) return element
			return null
		},
		querySelectorAll(selector) {
			const result = []
			const wantedSite = selector.match(/data-push115-site="([^"]+)"/)?.[1]
			const wantedKey = selector.match(/data-key="([^"]+)"/)?.[1]
			const visit = node => {
				for (const child of node.childNodes || []) {
					const classes = String(child.className || '').split(/\s+/)
					const classMatch = (!selector.includes('.push115-inline-btn') || classes.includes('push115-inline-btn'))
						&& (!selector.includes('.push115-record-btn') || classes.includes('push115-record-btn'))
						&& (!selector.includes('.push115-row-check') || classes.includes('push115-row-check'))
					const siteMatch = !wantedSite || child.dataset?.push115Site === wantedSite
					const keyMatch = !wantedKey || child.dataset?.key === wantedKey
					const notRecord = !selector.includes(':not(.push115-record-btn)') || !classes.includes('push115-record-btn')
					if (classMatch && siteMatch && keyMatch && notRecord && child.nodeType === 1) result.push(child)
					visit(child)
				}
			}
			visit(element)
			return result
		},
		getAttribute(name) {
			if (name === 'id') return id
			if (name === 'class') return className
			if (name === 'data-push115-site') return element.dataset.push115Site || ''
			return ''
		},
	}
	Object.defineProperty(element, 'textContent', {
		get() { return element.childNodes.length ? element.childNodes.map(child => child.textContent || '').join('') : text },
		set(value) { text = String(value); element.childNodes = [] },
	})
	for (const child of children) element.appendChild(child)
	return element
}

function makeTextCarrier(parts, options = {}) {
	const carrier = makeElement({ ...options, className: options.className || 'tpc_content' })
	const values = Array.isArray(parts) ? parts : [parts]
	const nodes = values.map(value => makeTextNode(value))
	nodes.forEach(node => carrier.appendChild(node))
	return { carrier, nodes }
}

function makeDocument({ title = '', heading = '', ogTitle = '', anchors = [], threadRoots = [] } = {}) {
	const headingElement = heading ? { textContent: heading } : null
	const meta = ogTitle
		? { content: ogTitle, getAttribute: name => name === 'content' ? ogTitle : '' }
		: null
	const body = makeElement({ tagName: 'body', children: threadRoots })
	return {
		title,
		body,
		documentElement: body,
		querySelector(selector) {
			if (selector === 'meta[property="og:title"]') return meta
			if (selector === 'h1, h2, h3, .subject, .f14') return headingElement
			return null
		},
		querySelectorAll(selector) {
			if (selector === 'a[href^="ed2k:"]') return anchors
			if (selector.includes('.tpc_content')) return threadRoots
			return []
		},
		createTreeWalker(root) {
			const nodes = []
			const visit = node => {
				if (node.nodeType === 3) nodes.push(node)
				else (node.childNodes || []).forEach(visit)
			}
			visit(root)
			let index = 0
			return { nextNode: () => nodes[index++] || null }
		},
		createElement(tagName) {
			return makeElement({ tagName })
		},
		createRange() {
			let startNode = null
			let startOffset = 0
			let endNode = null
			let endOffset = 0
			return {
				setStart(node, offset) { startNode = node; startOffset = offset },
				setEnd(node, offset) { endNode = node; endOffset = offset },
				surroundContents(wrapper) {
					if (startNode !== endNode) throw new Error('mock only supports one text node')
					const raw = String(startNode.nodeValue || '')
					const parent = startNode.parentElement
					wrapper.appendChild(makeTextNode(raw.slice(startOffset, endOffset)))
					if (!parent) return
					const index = parent.childNodes.indexOf(startNode)
					if (index < 0) return
					const before = raw.slice(0, startOffset)
					const after = raw.slice(endOffset)
					const replacements = []
					if (before) {
						startNode.nodeValue = before
						startNode.textContent = before
						replacements.push(startNode)
					}
					replacements.push(wrapper)
					if (after) replacements.push(makeTextNode(after))
					parent.childNodes.splice(index, 1, ...replacements)
					replacements.forEach(child => { child.parentNode = parent; child.parentElement = parent })
				},
				detach() {},
			}
		},
	}
}

const ed2k = (name, size = '123') => `ed2k://|file|${name}|${size}|ABCDEF0123456789ABCDEF0123456789|/`

test('South Plus config and adapter match only HTTP(S) read.php pages', () => {
	const push115 = loadRuntime(makeDocument(), { href: 'https://south-plus.net/read.php', protocol: 'https:', hostname: 'south-plus.net', pathname: '/read.php' })
	const adapter = push115.SiteAdapters.southplus

	assert.deepEqual([...push115.Config.SOUTHPLUS_HOSTNAMES], ['south-plus.net', 'www.south-plus.net'])
	assert.deepEqual([...push115.Config.SITE_DEFINITIONS.southplus.matches], [
		'*://south-plus.net/*',
		'*://www.south-plus.net/*',
	])
	assert.equal(push115.Config.DEFAULT_SITE_PROFILES.southplus.defaultProcessorProfile, 'jav')
	assert.equal(push115.Config.DEFAULT_SITE_PROFILES.southplus.batchSelection, true)
	assert.equal(push115.Config.DEFAULT_SITE_PROFILES.southplus.batchConcurrency, 2)
	assert.equal(push115.Config.DEFAULT_SITE_PROFILES.southplus.recordButton, true)

	for (const hostname of ['south-plus.net', 'www.south-plus.net']) {
		assert.equal(adapter.matches({ protocol: 'http:', hostname, pathname: '/read.php' }), true, hostname)
		assert.equal(adapter.matches({ protocol: 'https:', hostname, pathname: '/read.php/' }), true, `${hostname} slash`)
	}
	for (const location of [
		{ protocol: 'ftp:', hostname: 'south-plus.net', pathname: '/read.php' },
		{ protocol: 'https:', hostname: 'south-plus.net.evil.example', pathname: '/read.php' },
		{ protocol: 'https:', hostname: 'forum.south-plus.net', pathname: '/read.php' },
		{ protocol: 'https:', hostname: 'south-plus.net', pathname: '/index.php' },
		{ protocol: 'https:', hostname: 'south-plus.net', pathname: '/read.php/other' },
	]) assert.equal(adapter.matches(location), false, JSON.stringify(location))
})

test('Manifest and build architecture include both South Plus origins and its adapter', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'))
	const permissions = new Set(manifest.optional_host_permissions)
	for (const hostname of ['south-plus.net', 'www.south-plus.net']) {
		assert.equal(permissions.has(`*://${hostname}/*`), true, hostname)
	}
	const build = fs.readFileSync(path.join(extension, '../..', 'scripts/build.py'), 'utf8')
	assert.match(build, /content\/sites\/south-plus\.js/)
})

test('South Plus discovers real ED2K links, keeps file names, and deduplicates by DownloadIntent key', () => {
	const firstUrl = ed2k('MNGS-060%20restored.mp4')
	const secondUrl = ed2k('MIDA-190 4K60fps.mp4')
	const thirdUrl = ed2k('SNOS00301_sample.mkv')
	const anchors = [
		makeAnchor(firstUrl, '不应覆盖文件名'),
		makeAnchor(firstUrl, '重复链接'),
		makeAnchor(secondUrl, 'MIDA-190 alternate text'),
		makeAnchor(thirdUrl),
		makeAnchor('ed2k://|server|example|4662|', '无效 ED2K')
	]
	const pageUrl = 'https://www.south-plus.net/read.php?tid-2960797-keyword-av%7Cav.html'
	const document = makeDocument({ title: 'ED2K LADA JUSNA JAV restored', anchors })
	const push115 = loadRuntime(document, { href: pageUrl, protocol: 'https:', hostname: 'www.south-plus.net', pathname: '/read.php' })
	const downloads = push115.SiteAdapters.southplus.discoverDownloads()

	assert.equal(downloads.length, 3)
	assert.equal(downloads[0].element, anchors[0])
	assert.equal(downloads[0].sourceElement, anchors[0])
	assert.equal(downloads[0].url, firstUrl)
	assert.equal(downloads[0].title, 'MNGS-060 restored.mp4')
	assert.equal(downloads[0].code, 'MNGS-060')
	assert.equal(downloads[0].metadata.fileName, 'MNGS-060 restored.mp4')
	assert.equal(downloads[0].metadata.ed2kFileName, 'MNGS-060 restored.mp4')
	assert.equal(downloads[1].title, 'MIDA-190 4K60fps.mp4')
	assert.equal(downloads[1].code, 'MIDA-190')
	assert.equal(downloads[2].code, 'SNOS-00301')
	assert.equal(new Set(downloads.map(download => download.key)).size, 3)
})

test('South Plus discovers plain-text ED2K links without anchors, normalizes HTML entities and line breaks, and keeps their text carrier', () => {
	const firstUrl = ed2k('MNGS-060%20restored.mp4')
	const secondUrl = ed2k('MIDA-190%204K60fps.mp4', '456')
	const { carrier } = makeTextCarrier([
		`正文：${firstUrl}\n下一条：ed2k://|file|MIDA-190%204K60fps.mp4|456|ABCDEF0123456789ABCDEF0123456789`,
		'|/ 结束',
	])
	const pageUrl = 'https://www.south-plus.net/read.php?tid-2960797-keyword-av%7Cav.html'
	const document = makeDocument({ title: 'MNGS-060 and MIDA-190', threadRoots: [carrier] })
	const push115 = loadRuntime(document, { href: pageUrl, protocol: 'https:', hostname: 'www.south-plus.net', pathname: '/read.php' })
	const downloads = push115.SiteAdapters.southplus.discoverDownloads()

	assert.equal(downloads.length, 2)
	assert.equal(downloads[0].url, firstUrl)
	assert.equal(downloads[1].url, secondUrl)
	assert.equal(downloads[0].title, 'MNGS-060 restored.mp4')
	assert.equal(downloads[1].title, 'MIDA-190 4K60fps.mp4')
	assert.equal(downloads[0].code, 'MNGS-060')
	assert.equal(downloads[1].code, 'MIDA-190')
	assert.equal(downloads[0].element, carrier)
	assert.equal(downloads[0].sourceElement, carrier)
	assert.equal(downloads[1].element, carrier)
	assert.equal(downloads[1].sourceElement, carrier)
	assert.equal(downloads[0].metadata.fileName, 'MNGS-060 restored.mp4')
	assert.equal(downloads[1].metadata.ed2kFileName, 'MIDA-190 4K60fps.mp4')
	assert.equal(downloads[1].metadata.sourceType, 'text')
})

test('South Plus enhancePage renders a centralized resource list for same-carrier text links', () => {
	const firstUrl = ed2k('MNGS-060%20restored.mp4')
	const secondUrl = ed2k('MIDA-190%204K60fps.mp4', '456')
	const { carrier } = makeTextCarrier(`${firstUrl}\n${secondUrl}`)
	const pageUrl = 'https://www.south-plus.net/read.php?tid-2960797'
	const document = makeDocument({ title: 'ED2K LADA JAV 2', threadRoots: [carrier] })
	const push115 = loadRuntime(document, { href: pageUrl, protocol: 'https:', hostname: 'www.south-plus.net', pathname: '/read.php' })
	const adapter = push115.SiteAdapters.southplus
	const downloads = adapter.discoverDownloads()

	assert.equal(downloads.length, 2)
	assert.equal(downloads[0].sourceElement, carrier)
	assert.equal(downloads[1].sourceElement, carrier)

	push115.Content = { getProfile: () => ({ batchSelection: true, recordButton: true }) }
	adapter.enhancePage()

	const toolbar = document.body.childNodes.find(child => child.id === 'push115-southplus-toolbar')
	assert.ok(toolbar)
	assert.equal(toolbar.dataset.push115Site, 'southplus')

	const list = document.body.childNodes.find(child => child.id === 'push115-southplus-resource-list')
	assert.ok(list)
	assert.equal(list.className, 'push115-resource-list')
	assert.equal(list.dataset.push115Site, 'southplus')

	const [heading, rows] = list.childNodes
	assert.equal(heading.className, 'push115-resource-list-heading')
	assert.equal(heading.childNodes[0].textContent, 'South Plus ED2K 资源列表')
	assert.equal(heading.childNodes[1].textContent, '共 2 项')
	assert.equal(rows.className, 'push115-resource-list-rows')
	assert.equal(rows.childNodes.length, downloads.length)

	for (const [index, download] of downloads.entries()) {
		const row = rows.childNodes[index]
		assert.equal(row.className, 'push115-resource-row')
		assert.equal(row.dataset.push115Site, 'southplus')
		assert.equal(row.dataset.key, download.key)

		const [checkbox, name, send, record] = row.childNodes
		assert.equal(checkbox.type, 'checkbox')
		assert.equal(checkbox.className, 'push115-row-check')
		assert.equal(checkbox.dataset.push115Site, 'southplus')
		assert.equal(checkbox.dataset.key, download.key)
		assert.equal(name.className, 'push115-resource-name')
		assert.equal(name.textContent, download.title)
		assert.equal(name.title, download.url)
		assert.equal(send.className, 'push115-inline-btn push115-resource-btn')
		assert.equal(send.textContent, '发送到115')
		assert.equal(record.className, 'push115-inline-btn push115-record-btn push115-resource-btn')
		assert.equal(record.textContent, '记录')
	}
	assert.equal(carrier.adjacentElements.length, 0)
})

test('South Plus decodes entities in plain-text ED2K filenames, ignores scripts and injected nodes, and deduplicates text with anchors', () => {
	const url = ed2k('MNGS-060%20restored&v2.mp4')
	const { carrier } = makeTextCarrier([
		`ed2k://|file|MNGS-060%20restored&amp;v2.mp4|123|ABCDEF0123456789ABCDEF0123456789|/\n${url}`,
	])
	const script = makeElement({ tagName: 'script', children: [makeTextNode(ed2k('SCRIPT-001.mp4'))] })
	const injected = makeElement({ id: 'push115-southplus-toolbar', children: [makeTextNode(ed2k('INJECTED-002.mp4'))] })
	carrier.appendChild(script)
	carrier.appendChild(injected)
	const pageUrl = 'https://south-plus.net/read.php?tid-1'
	const anchor = makeAnchor(url, 'real anchor')
	const document = makeDocument({
		title: 'MNGS-060 restored',
		anchors: [anchor],
		threadRoots: [carrier],
	})
	const push115 = loadRuntime(document, { href: pageUrl, protocol: 'https:', hostname: 'south-plus.net', pathname: '/read.php' })
	const downloads = push115.SiteAdapters.southplus.discoverDownloads()

	assert.equal(downloads.length, 1)
	assert.equal(downloads[0].element, anchor)
	assert.equal(downloads[0].sourceElement, anchor)
	assert.equal(downloads[0].url, url)
	assert.equal(downloads[0].metadata.fileName, 'MNGS-060 restored&v2.mp4')
})

test('South Plus extracts reliable codes from file/link/page text, including START-593', () => {
	const pageUrl = 'https://south-plus.net/read.php?tid-2960797'
	const page = makeDocument({ title: 'start-593 LADA JUSNA JAV restored' })
	const push115 = loadRuntime(page, { href: pageUrl, protocol: 'https:', hostname: 'south-plus.net', pathname: '/read.php' })
	const adapter = push115.SiteAdapters.southplus

	assert.equal(adapter.extractCode('MNGS-060 MIDA-190 SONE-275 MIDV-985 SNOS00301'), 'MNGS-060')
	assert.equal(adapter.extractCode('SNOS00301_sample.mkv'), 'SNOS-00301')
	assert.equal(adapter.extractCode('start-593'), 'START-593')
	const pageMetadata = adapter.extractPageMetadata()
	assert.equal(pageMetadata.title, 'start-593 LADA JUSNA JAV restored')
	assert.equal(pageMetadata.code, 'START-593')
	assert.equal(pageMetadata.pageCode, 'START-593')
	assert.equal(pageMetadata.pageUrl, pageUrl)

	const validPage = makeDocument({ title: 'MIDA-190 restored collection' })
	const validPush115 = loadRuntime(validPage, { href: pageUrl, protocol: 'https:', hostname: 'south-plus.net', pathname: '/read.php' })
	assert.equal(validPush115.SiteAdapters.southplus.extractPageMetadata().pageCode, 'MIDA-190')
})
