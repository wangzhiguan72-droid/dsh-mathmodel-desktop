# Fusion 本地适配

版本 0.2.11+mathmodel.2，目标内核固定 0.2.2-rc.3。保留原有首轮工具、规划式假完成、模型切换保活和客户端 sessions/remote/remote.session 注入修复。Host 改用展平 startActivation、新工具执行批次与作用域 NativeToolExecutor，按精确 activation.dispose 回收本次子代理，避免关闭同级任务。Host 已由本地源码以 TypeScript 7.0.2 / tsdown 0.23.7 编译并通过严格类型检查；客户端沿用已修复产物。源码与构建产物分别锁定哈希。
