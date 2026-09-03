;(function (global) {
	'use strict'
	const CSS = `
.push115-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(6px);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.push115-modal{width:420px;max-width:92vw;overflow:hidden;border-radius:16px;background:#fff;color:#1d1d1f;box-shadow:0 20px 60px rgba(0,0,0,.24)}.push115-download-confirmation{width:620px;max-height:92vh;overflow:auto}
.push115-modal-header,.push115-modal-footer{padding:15px 20px;background:#fafafa}.push115-modal-header{border-bottom:1px solid rgba(0,0,0,.07)}.push115-modal-footer{display:flex;justify-content:flex-end;gap:10px}
.push115-modal-title{margin:0;font-size:16px}.push115-modal-body{padding:16px 20px}.push115-modal-info{margin:0 0 12px;color:#666;font-size:13px}.push115-modal-field-label{display:block;margin:12px 0 6px;font-size:13px;font-weight:650}.push115-modal-textarea{box-sizing:border-box;width:100%;min-height:132px;resize:vertical;padding:10px;border:1px solid #d5d5d8;border-radius:8px;background:#fff;color:#1d1d1f;font:12px/1.5 ui-monospace,monospace;word-break:break-all}.push115-profile-warning{margin:0 0 10px;padding:9px 11px;border-radius:8px;background:#fff8df;color:#715300;font-size:12px;line-height:1.45}.push115-validation{max-height:92px;overflow:auto;margin-top:6px;font-size:12px}.push115-validation-summary{margin:0;color:#2c7a43}.push115-validation-summary.error,.push115-validation-item.invalid{color:#c52d25}.push115-validation-item.duplicate{color:#9a6812}
.push115-modal-select{width:100%;margin-bottom:8px;padding:8px 10px;border:1px solid #d5d5d8;border-radius:8px;background:#fff;color:#1d1d1f}.push115-modal-btn,.push115-inline-btn,.push115-batch-btn{border:0;border-radius:8px;padding:8px 13px;font-size:12px;font-weight:650;cursor:pointer}.push115-modal-btn:disabled,.push115-inline-btn:disabled,.push115-batch-btn:disabled{opacity:.55;cursor:not-allowed}
.push115-modal-btn-cancel{background:#ececf0;color:#0066cc}.push115-modal-btn-confirm,.push115-inline-btn,.push115-batch-btn{background:#087ff5;color:#fff}
.push115-inline-btn{display:inline-flex;align-items:center;margin:3px 6px;padding:5px 9px;vertical-align:middle;line-height:1.2}.push115-inline-btn.is-success{background:#2e9b4b}.push115-inline-btn.is-error{background:#d73a32}
.push115-toast{position:fixed;top:16px;right:16px;z-index:2147483647;max-width:420px;padding:12px 18px;border-radius:10px;color:#fff;background:#0a84ff;box-shadow:0 4px 18px rgba(0,0,0,.2);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.push115-toast.success{background:#34a853}.push115-toast.error{background:#d93025}.push115-toast.warning{background:#e68a00}
.push115-site-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0;padding:8px 10px;border:1px solid rgba(8,127,245,.22);border-radius:8px;background:#f6faff;color:#234;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.push115-row-check{width:16px;height:16px;margin:0 7px 0 0;vertical-align:middle;accent-color:#087ff5}.push115-toolbar-hint{margin-left:auto;color:#65758a}.push115-batch-btn.push115-secondary{background:#e7f1ff;color:#075fb3}
.push115-batch-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:420px;max-width:calc(100vw - 32px);max-height:55vh;overflow:auto;padding:14px;border-radius:13px;background:#fff;color:#222;box-shadow:0 10px 36px rgba(0,0,0,.25);font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.push115-batch-panel h3{margin:0 0 10px;font-size:14px}.push115-batch-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:7px 0;border-top:1px solid #eee}.push115-batch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.push115-batch-status{color:#687}.push115-batch-status.submitting{color:#075fb3}.push115-batch-status.success{color:#25833c}.push115-batch-status.failed{color:#c52d25}.push115-batch-status.duplicate{color:#9a6812}
`

	function ensure() {
		if (document.getElementById('push115-content-styles')) return
		const style = document.createElement('style')
		style.id = 'push115-content-styles'
		style.textContent = CSS
		;(document.head || document.documentElement).appendChild(style)
	}

	global.Push115.Content = global.Push115.Content || {}
	global.Push115.Content.Styles = { ensure }
})(globalThis)
