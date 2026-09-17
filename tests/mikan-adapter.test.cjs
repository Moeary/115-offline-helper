const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')
const supportedHostnames = [
	'mikan.congvps.icu',
	'mikanani.me',
	'mikanime.tv',
	'mikanani.kas.pub',
	'mikan.tangbai.cc',
]

function loadRuntime() {
	const context = vm.createContext({ console, URL })
	for (const relative of ['shared/config.js', 'shared/anime-series.js', 'content/sites/mikan.js']) {
		vm.runInContext(fs.readFileSync(path.join(extension, relative), 'utf8'), context, { filename: relative })
	}
	return context.Push115
}

test('Mikan adapter and series identity recognize all supported detail-page hostnames', () => {
	const push115 = loadRuntime()
	const adapter = push115.SiteAdapters.mikan

	assert.deepEqual([...push115.Config.MIKAN_HOSTNAMES], supportedHostnames)
	assert.deepEqual([...push115.Config.SITE_DEFINITIONS.mikan.matches], supportedHostnames.map(hostname => `*://${hostname}/*`))

	for (const hostname of supportedHostnames) {
		const pageUrl = `https://${hostname}/Home/Bangumi/2087`
		assert.equal(adapter.matches({ hostname, pathname: '/Home/Bangumi/2087' }), true, hostname)
		const series = push115.AnimeSeries.fromPage(pageUrl + '?from=rss#group', 'Example Season 2')
		assert.equal(series?.key, 'mikan:2087', hostname)
		assert.equal(series?.title, 'Example Season 2', hostname)
		assert.equal(series?.pageUrl, pageUrl, hostname)
	}
})

test('Mikan identity rejects non-Mikan hosts and non-detail pages', () => {
	const push115 = loadRuntime()
	const adapter = push115.SiteAdapters.mikan
	const rejectedHostnames = [
		'example.org',
		'www.mikanani.me',
		'mikanani.me.evil.example',
		'mikanani.shirosakihana.moe',
	]

	for (const hostname of rejectedHostnames) {
		assert.equal(adapter.matches({ hostname }), false, hostname)
		assert.equal(push115.AnimeSeries.fromPage(`https://${hostname}/Home/Bangumi/2087`, 'Example Season 2'), null, hostname)
	}

	for (const pathName of ['/Home/Search', '/Home/Bangumi/0', '/Home/Bangumi/not-an-id', '/Home/Bangumi/2087/extra']) {
		assert.equal(push115.AnimeSeries.fromPage(`https://mikanani.me${pathName}`, 'Example Season 2'), null, pathName)
	}
	assert.equal(push115.AnimeSeries.fromPage('https://mikanani.me/Home/Bangumi/2087', ''), null)
})

test('Manifest optional host permissions stay aligned with the Mikan hostname list', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'))
	const permissions = new Set(manifest.optional_host_permissions)
	for (const hostname of supportedHostnames) assert.equal(permissions.has(`*://${hostname}/*`), true, hostname)
})
