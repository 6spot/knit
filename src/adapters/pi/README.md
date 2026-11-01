# Pi 适配

直接启动本机 Pi CLI，处理公开 stdin/stdout RPC、模型选择、事件、原生引用、恢复和受控取消；不导入 Pi SDK／RpcClient。阶段新会话默认在稳定私有目录保存，原记录不可用时按 prefer 从任务文件续做。

项目薄桥接模板放 assets/pi，由 init 生成；安装 ready 不替代宿主信任。活跃原生文件只经宿主 API／客户端写入，查询不追加。
