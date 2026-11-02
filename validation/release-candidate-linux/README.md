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

## 平台范围

- Linux + Node 24 + Pi 1.4.0：已实际安装、init、start。
- macOS：未实测，后续按 B001 补验；当前候选不声明 macOS 兼容，用户 2026-11-02 已接受以 Linux 为准。
- 未执行 npm publish、部署或外部发布。候选包名 `knit@0.1.0` 在公共 registry 可能已被占用；未来发布需改 scope／名称、版本和许可证后再评估。
