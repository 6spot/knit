# 任务025 Linux 候选包安装验证

环境：Linux、Node v24.21.0、npm 11.19.0、Pi 1.4.0。

```text
npm pack                         knit-0.1.0.tgz，162 文件，214.5 kB
本地 npm install                 成功
knit --version                   0.1.0
knit init --client pi            ready；安装映射指向本机 dist/cli/knit.js
knit start --dir <project> -- --version   1.4.0
```

包内容仅 `README.md`、`package.json`、`assets/`、`dist/`；无 `src/`、`test/`、`tasks/`、`validation/`、研究或私有记录、凭据、开发任务目录。桥接模板与 `dist/contracts/bridge-tools.json` 同源并随包发布。

## 未完成／阻塞

- macOS 未在真实机器执行构建、安装、init、start 或桥接；不能声称 macOS 兼容。
- 未发布 npm、未部署、未创建外部发布流程。
- 因此任务025保持 blocked，任务026发布就绪审查不能通过。
