---
name: dsh-web-healthcheck
description: |-
  DSH Web GUI（http://127.0.0.1:3080）健康检查与"界面无反应"类问题诊断。当用户反馈 无法新建会话、新建会话按钮点了没反应、页面白屏/卡住、会话列表不更新、重启 harness 后界面异常，或任何 Web 界面疑似故障时使用。含一键全链路自检脚本（页面与前端资源 / 后端 RPC / WebSocket 事件通道 / 会话创建回滚验证）与"服务端全绿 → 浏览器陈旧标签页 → Ctrl+F5"的判定流程。
whenToUse: |-
  用户说"新建会话失败/没反应""界面打不开""页面卡住""按钮点了没动静"等 GUI 症状时自动执行。
---

# DSH Web GUI 健康检查（dsh-web-healthcheck）

## 触发特征
- 用户反馈：无法建立新的会话、点"新建会话"完全没反应、页面白屏或一直转圈、会话列表不更新
- 常见时间点：harness（`dsh web`）重启之后

## 背景（先懂架构，再动手）
- 前端是浏览器内运行的 SPA + 插件包，唯一入口 `http://127.0.0.1:3080`
- RPC 走 `POST /api/<method>`（如 `/api/session.create`），JSON 信封：
  `{"type":"client-request","rpcId":"...","method":"...","payload":{...}}`，content-type 必须是 `application/json`
- 事件通道是 WebSocket：`ws://127.0.0.1:3080/api/events.mux` 与 `/api/events.host`
  （普通 GET 这些路径返回 426 upgrade required 是**正常**现象，说明通道已注册）
- 页面 HTML 里的 `window.__DSH_BOOT__` 列出全部前端包 URL；`/assets/*` 是壳资源
- **关键认知**：侧边栏"新建会话"按钮失败时，前端只在 console 打 `new session failed`，
  界面上没有任何提示——"点了没反应"通常是**前端本地失败**，不代表后端拒绝了请求

## 诊断流程（按顺序执行）
1. **一键自检**：`node scripts\healthcheck.mjs [baseUrl]`（默认 `http://127.0.0.1:3080`）
   逐项输出 PASS/FAIL，退出码 0 = 全绿。覆盖：
   - `GET /` 页面与 `__DSH_BOOT__` 存在性
   - 全部前端资源（`/assets/*`、`/plugins/*`）HTTP 200
   - RPC：`session.list`、`workspace.list`、`session.create`（创建链路端到端验证）
   - WebSocket：mux 通道握手且收到帧、host 通道握手
   - 脚本会创建一个空白测试会话验证创建链路，随后自动 `workspace.archiveSession` 清理，不留垃圾
2. **全绿时**：服务端可认定健康。第一嫌疑 = **浏览器陈旧标签页**：harness 重启后，重启前打开的
   标签页内存里仍是旧版前端 JS，与当前服务端不匹配，点"新建会话"静默失败
   - 让用户 `Ctrl+F5` 强制刷新（或关掉标签重开 URL）再试——这一步多数直接恢复
   - 仍失败：让用户按 F12 打开 Console，再点一次"新建会话"，把红色报错原文拿回来继续排查
     （此时才是真正的前端运行时错误，需要具体报错定位，不要瞎猜）
3. **有 FAIL 项时**：按失败层定位，不要跳步：
   - 页面/资源失败 → 查服务进程与端口：`Get-NetTCPConnection -LocalPort 3080`；
     多个 node 实例并存 = 隐患（见安全规则）
   - 会话相关失败 → 用 `session-log-repair` 技能的 `scan-all.mjs` 扫描
     `%USERPROFILE%\.dsh\sessions` 是否有日志损坏
   - WS 失败但 HTTP 正常 → 查事件通道注册或反向代理配置
   - 自检全绿但仍异常 → 回到第 2 条，浏览器侧排查
4. **结论规则**：先证据后断言。每一层都要有实测输出支撑（HTTP 状态码、RPC 响应、WS 帧），
   不要凭"看起来正常"跳过任何一层

## 安全规则
- 不要未征得用户同意就重启 harness / kill 进程
- 重启前必须确认旧实例真的退出（本机有过 taskkill 拒绝访问、新旧实例并存导致会话日志损坏的前科）
- 诊断产生的测试会话必须清理（脚本已自动 archive）
- 浏览器侧问题不要通过改服务端代码去"绕过"
- 给用户的结论和链接都要实测验证过

## 已修复案例（2026-08-17）
- 症状：点"新建会话"完全没反应。全链路自检全绿（单进程/日志无损坏/RPC/WS/资源全部实测通过）；
  根因 = 02:30 重启残留 + 02:52 新实例接管，浏览器标签页仍跑重启前的旧前端，按钮静默失败。
  处理：用户 Ctrl+F5 强刷即恢复，服务端零改动。
