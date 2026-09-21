const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const extension = path.join(__dirname, '../src/chrome-extension')
const load = (context, relative) => vm.runInContext(
	fs.readFileSync(path.join(extension, relative), 'utf8'),
	context,
	{ filename: relative },
)

test('small-video threshold can be disabled without disabling explicit junk rules', () => {
	const context = vm.createContext({ Push115: {} })
	load(context, 'shared/file-rules.js')
	const rules = context.Push115.FileRules
	const thresholdBytes = 100 * 1024 * 1024
	const video = { fid: 'video-1', sha: 'sha-1', n: 'episode.mp4', size: 20 * 1024 * 1024, duration: 90 }

	const disabled = rules.getDeletionDecision(video, {
		thresholdBytes,
		mainVideoIds: new Set(),
		rules: rules.buildRules({ smallVideoCleanup: false }),
	})
	assert.equal(disabled.shouldDelete, false)
	assert.equal(disabled.reason, 'small-video-filter-disabled')

	const enabled = rules.getDeletionDecision(video, {
		thresholdBytes,
		mainVideoIds: new Set(),
		rules: rules.buildRules({ smallVideoCleanup: true }),
	})
	assert.equal(enabled.shouldDelete, true)
	assert.equal(enabled.reason, 'short-video')

	const junk = { fid: 'junk-1', sha: 'sha-2', n: '说明.txt', size: 1024 }
	const junkDecision = rules.getDeletionDecision(junk, {
		thresholdBytes,
		rules: rules.buildRules({ smallVideoCleanup: false }),
	})
	assert.equal(junkDecision.shouldDelete, true)
	assert.equal(junkDecision.reason, 'explicit-junk-extension')
})

test('default site profiles enable small-video cleanup only for AV sites', () => {
	const context = vm.createContext({ Push115: {} })
	load(context, 'shared/config.js')
	const config = context.Push115.Config
	const profiles = config.normalizeSiteProfiles(undefined, config.DEFAULT_CONFIG)

	assert.equal(profiles.javbus.smallVideoCleanup, true)
	assert.equal(profiles.southplus.smallVideoCleanup, true)
	assert.equal(profiles.mikan.smallVideoCleanup, false)
	assert.equal(profiles.nyaa.smallVideoCleanup, false)
	assert.equal(profiles.sukebei.smallVideoCleanup, false)
	assert.equal(profiles.generic.smallVideoCleanup, false)

	const overridden = config.normalizeSiteProfiles({
		mikan: { smallVideoCleanup: true },
		javbus: { smallVideoCleanup: false },
	}, config.DEFAULT_CONFIG)
	assert.equal(overridden.mikan.smallVideoCleanup, true)
	assert.equal(overridden.javbus.smallVideoCleanup, false)
})

test('generic processor passes the per-site small-video switch to cleanup', async () => {
	const captured = []
	const context = vm.createContext({
		Push115: {
			Background: {
				Processors: {
					Cleanup: {
						buildRules: config => {
							captured.push(config.push115_small_video_cleanup)
							return {}
						},
						cleanSmallFiles: async () => ({ count: 0, files: [], scannedFolders: 1 }),
					},
				},
			},
		},
	})
	load(context, 'background/processors/generic.js')
	const processor = context.Push115.Background.Processors.generic
	const base = {
		config: { push115_auto_delete_small: true, push115_delete_size_threshold: 100 },
		appendLog: () => {},
		targetCid: '10',
	}

	await processor.process({ ...base, task: { sourceSite: 'mikan', processorProfile: 'anime' } })
	await processor.process({ ...base, task: { sourceSite: 'southplus', processorProfile: 'jav' } })
	assert.deepEqual(captured, [false, true])
})
