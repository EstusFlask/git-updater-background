# git-updater-background

[English](README.md) | 简体中文

基于 [TeeJS/git-updater](https://github.com/TeeJS/git-updater) 的应用更新器 fork：从 GitHub Releases 跟踪、下载和更新应用。

## 本分支新增

- 登录时自动检查或更新已跟踪应用，任务完成后退出。
- 可选择安装前询问、是否显示窗口，以及是否在更新前关闭运行中的应用。
- 单个下载的大小上限，默认 500 MiB，可调整或关闭。
- 大文件分块哈希与检查，以及对应设置和状态提示。

关闭应用时会先尝试正常退出，必要时强制关闭；启用前请保存其他应用中的工作。

## 获取与使用

前往 [本分支 Releases](https://github.com/EstusFlask/git-updater-background/releases)，按实际列出的附件下载。当前已发布的 `v0.2.6` 附件为 Windows x64/arm64 ZIP，解压后运行 `git-updater.exe`。

上游具有 Windows、macOS 和 Linux 支持，但上游二进制不自动包含本分支改动。其他平台的包格式、签名和公证状态请以对应下载产物为准。

1. 打开 Settings，选择便携应用存放目录。
2. 点击 Add app，填写 `owner/repo` 或 GitHub Releases 地址。
3. 选择 Portable 或 Installer，按需配置预发布版本。
4. 执行 Check all，再选择需要更新的应用。
5. 在 Settings 中配置可选的登录更新与下载上限。

## 从源码运行

```bash
npm install
npm start
```

开发检查和构建命令：

```bash
npm test
npm run dist
```

其他平台的打包命令、配置位置和实现细节见 [英文说明](README.md)、[`config.example.json`](config.example.json) 和 [`docs/INTERNALS.md`](docs/INTERNALS.md)。

## 与上游的关系

应用跟踪、平台检测、便携包更新和安装器处理基于原项目；本分支重点是登录更新流程及其控制项。原项目的署名、文档和相关许可信息继续保留。
