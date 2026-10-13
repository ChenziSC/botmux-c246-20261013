# 显式 Ask 的持久接续

普通 `botmux ask` 等待答案并写回 stdout；如果模型轮次先结束，晚到的 stdout 可能没有消费者。`--host-wait` 将问题、答案和接续责任登记到宿主，CLI 得到登记回执后退出。宿主通过既有原生输入队列向原会话提交后继轮次；登记成功、输入提交和执行完成是不同状态。

## 边界与状态

- Botmux 负责 app/session/chat/thread、原轮次/attempt 绑定、卡片权限、问题和答案持久化，以及原生队列接续。业务阶段、决定内容、审批权限规则和应用后的收集留给平台插件。
- 卡片答案通过原权限网关接受。回答 ACK 表示答案已保存；只有原生 `inputCommitted` 被观察到，接续才标为 `committed`。不以卡片更新或触发请求 HTTP 成功代替输入证据。
- 持久接续问题不因业务等待时间到期失效。未配置接续模式的阻塞 Ask 保持现有超时语义。
- 每个答案有稳定的原生输入幂等键。重启或响应丢失后先查原登记，复用原 trigger；已知登记消失时暴露 blocked，不能换一个 key 重放可能已执行的效果。
- `committed` 只证明后继输入已进入实际执行链；业务完成仍由原执行结果和平台收集器确认。

## 默认模式配置

既有命令可继续显式使用 `--host-wait`。无人值守机器人也可配置：

```json
{ "env": { "BOTMUX_ASK_DELIVERY_MODE": "continuation" } }
```

允许值仅为 `continuation` / `blocking`；未配置时保留普通阻塞 Ask。此项是受值校验的行为配置，其他 `BOTMUX_*` 身份、路由和控制变量仍禁止通过 per-bot env 覆盖。

配置走现有 per-session `injectEnv`。PTY 合入该子进程；tmux/zellij 在加载 shell 配置后注入该 pane，不写共享 server 环境。模式键同时进入现有 pane 清理/传递列表，使未配置的机器人不会读到共享 server 或 shell 遗留的模式。普通继承策略下，宿主显式导出的模式可作为默认值，per-bot 配置优先；strict 策略只接受显式配置或允许的继承。

## 验证

- `src/core/__tests__/ask-continuation.test.ts`：持久化、接续状态与故障分支的组件测试。
- `src/core/__tests__/ask-delivery-env.test.ts`：配置值边界、strict 策略、身份保护和同一真实 tmux server 上不同模式的 pane 隔离。
- `src/core/__tests__/fixtures/ask-runtime/run.py`：在 Linux bubblewrap 中启动完整构建包，执行真实 daemon → 消息入口 → Worker → codex-app runner → Ask CLI → 卡片网关 → 原生输入提交 → 同会话后继轮次。三个话题/群会话、进程冷重启、回调响应丢失和重复回调均从外部边界触发。命令不带 `--host-wait`，用于验证默认配置的完整传递。

运行进程回归：

```bash
bun run build
python3 src/core/__tests__/fixtures/ask-runtime/run.py --node /absolute/path/to/node
```

需要 Linux、bubblewrap、Node 22+ 和已安装依赖。脚本保持原 HOME 值，通过独立文件系统映射隔离机器人数据、缓存和模型配置；仅输出临时证据目录。可用 `--repo` 指定另一个精确构建目录，用 `--output` 保存结果。

进程回归只替换外部 IM 传输与模型。它不直接制造 registration/inputCommitted 或写成功回执，也不调用测试 reset 模拟重启。它证明运行时链路，不代替真实飞书网络、实际模型输出、平台业务收集或完整业务交付验收。
