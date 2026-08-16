# dsh-skills

DSH（DeepSeek Harness）本机运维诊断技能集。每个子目录是一个独立技能（SKILL.md + 可执行脚本），
复制到本地技能目录 `%USERPROFILE%\.agents\skills\`（Linux/macOS 为 `~/.agents/skills/`）后即可被会话自动发现加载。

## 技能列表

### dsh-web-healthcheck — Web GUI 健康检查 / "新建会话无反应"诊断
- 适用：无法新建会话、按钮点击无反应、页面白屏/卡住、会话列表不更新、重启 harness 后界面异常
- 内容：一键全链路自检脚本 `scripts\healthcheck.mjs`（页面与前端资源 / 后端 RPC / WebSocket 事件通道 / 会话创建回滚验证），
  以及"服务端全绿 → 浏览器陈旧标签页 → Ctrl+F5"的判定流程
- 案例（2026-08-17）：harness 重启后旧标签页跑旧前端，新建会话按钮静默失败，强刷恢复

### session-log-repair — 会话历史日志损坏检测与修复
- 适用：报错 `corrupt session log: seq gap ...` / `history unavailable`、旧会话打不开、记忆受损
- 内容：`scan-all.mjs` 全量扫描 → `analyze-gaps.mjs` 空洞分析 → `repair-generic.mjs` 删除过期写入者重叠事件（自动备份）
  → `final-verify.mjs` 校验
- 原则：只删重叠/过期时间线，绝不重编号 seq、绝不伪造事件

## 环境要求
- Node ≥ 22（脚本为 ESM .mjs，使用内置 `fetch` / `WebSocket` / `crypto` / `zstd`）
- Windows（路径示例为 Windows 形式；脚本逻辑与平台无关）

## 安装
```
xcopy /E /I dsh-web-healthcheck %USERPROFILE%\.agents\skills\dsh-web-healthcheck
xcopy /E /I session-log-repair   %USERPROFILE%\.agents\skills\session-log-repair
```

## 安全说明
- 诊断脚本只读 + 回滚式验证：`healthcheck.mjs` 创建的测试会话会自动归档清理
- 修复类脚本（session-log-repair）修改前自动备份原文件到 `backup\`，修复失败可从备份恢复
- 修复前务必确认目标日志已停止写入（mtime 不再变化）
