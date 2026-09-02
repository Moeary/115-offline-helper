# 源码与开发说明

Chrome 扩展源码位于 `src/chrome-extension/`。`dist/extension/` 是由 Pixi 构建生成、供 Chrome 加载的目录，不应直接编辑。

## 本地命令

在仓库根目录执行：

```powershell
pixi install
pixi run build
pixi run deploy
pixi run clean
```

`pixi run deploy` 会先校验 Manifest V3 和图标、popup、service worker 等入口，再将源码复制到 `dist/extension/`，最后按根目录 `config.toml` 中 `[browser] chrome` 的路径打开 `chrome://extensions/`，并请求 Chrome 加载编译产物。

如果 Chrome 已经在运行，Chrome 可能忽略本次启动参数。首次安装时请在扩展页开启“开发者模式”，点击“加载已解压的扩展”，选择：

```text
dist/extension
```

后续执行 `pixi run deploy` 后，在扩展卡片上点击“重新加载”即可使用最新产物。

## 目录结构

```text
src/
├─ chrome-extension/   MV3 扩展源码
└─ README.md           开发说明
scripts/
├─ build.py            校验并复制扩展到 dist/
├─ deploy.py           查找 Chrome 并打开部署页
└─ clean.py            清理构建产物
config.example.toml    可提交的 Chrome 路径模板
config.toml            当前电脑配置，不提交 Git
pixi.toml              Pixi 环境与任务定义
```
