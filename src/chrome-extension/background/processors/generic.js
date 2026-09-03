;(function (global) {
	'use strict'
	const processors = global.Push115.Background.Processors

	async function process(context) {
		const { task, targetCid, config, appendLog } = context
		const messages = []
		if (config.push115_auto_delete_small === true) {
			const threshold = Number(config.push115_delete_size_threshold) || 100
			const rules = processors.Cleanup.buildRules(config)
			const result = await processors.Cleanup.cleanSmallFiles(targetCid, threshold, rules)
			if (result.count > 0) messages.push(`回收 ${result.count} 个明确垃圾文件`)
			appendLog(task, `安全扫描 ${result.scannedFolders} 个目录，回收 ${result.count} 个文件`)
			for (const file of result.files.slice(0, 40)) appendLog(task, `回收：${file.name}（${file.reason}）`)
		}
		return messages
	}

	processors.generic = { process }
	// Stored 1.1.0 tasks may still name the old profile until migration is persisted.
	processors.default = processors.generic
})(globalThis)
