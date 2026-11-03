/**
 * Knit Rex worker 扩展加载模板。
 *
 * `knit init` 不复制本文件到用户项目；它作为安装包的第二加载入口存在，
 * 使运行期在编译产物缺失时仍能从 assets/templates 定位同一份 worker 扩展。
 * 实际实现只在 dist/adapters/rex/worker-extension.js；不在模板内复制状态机。
 */
export { default } from "../../../../dist/adapters/rex/worker-extension.js";
