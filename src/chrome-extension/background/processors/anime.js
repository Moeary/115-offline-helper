;(function (global) {
	'use strict'
	const processors = global.Push115.Background.Processors

	async function process(context) {
		// Anime deliberately keeps the torrent's original file and directory names.
		return processors.generic.process(context)
	}

	processors.anime = { process }
	processors.none = processors.anime
})(globalThis)
