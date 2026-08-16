---
name: session-log-repair
description: |-
  修复 DSH 会话历史日志损坏。出现 "corrupt session log: seq gap in committed region"、"history unavailable for session"、会话记录/历史打不开、记忆受损等报错或反馈时使用。包含检测、备份、分析、删除过期写入者重叠事件、重建、验证的完整流程和现成脚本。
whenToUse: |-
  系统或用户报告旧会话打不开、历史加载失败、seq 空洞、会话日志损坏时自动执行本流程。
---

# 会话日志修复（session-log-repair）

## 触发特征
- 报错：`corrupt session log: seq gap in committed region at line N (expected X, got Y)`
- 报错：`history unavailable for session "..."`
- 用户说旧会话/记忆打不开、历史丢失、会话记录损坏

## 背景（DSH 会话存储格式）
- 日志位置：`%USERPROFILE%\.dsh\sessions\<规范化cwd目录>\<session-id>\session.jsonl.zstd`（Linux/macOS 为 `~/.dsh/sessions/...`）
- 物理格式：多个带校验和的 zstd 帧直接拼接；**首帧 = 恰好一行 header**（`{"type":"session","id":...,"cwd":...}`）；其余帧 = 事件行（普通事件行带 `seq`，或打包行 `{"type":"text-chunks|reasoning-chunks|tool-call-chunks","seq0":N,"data":{"texts"/"args":[...]}}`，成员数即事件数，seq 为 seq0..seq0+n-1）
- 后端 load 校验：帧完整+校验和通过；header id 必须等于所在目录名；解码后 seq 必须 0..N-1 连续，有空洞即整体拒绝
- 损坏成因：同一会话被多个写入者并发打开，持有旧游标的过期写入者把与已提交事件 **seq 重叠** 的批次追加到文件尾（物理上帧都完整、尾部自洽，但整体 seq 不连续）

## 修复流程（按顺序执行）
1. **全量扫描定位**：`node scripts\scan-all.mjs "%USERPROFILE%\.dsh\sessions"` → 列出所有损坏日志及空洞位置
2. **细看空洞上下文**：`node scripts\analyze-gaps.mjs <日志文件>` → 打印每个空洞 ±10 行的 seq/类型
3. **判定要删除的"过期写入者"事件块**：
   - **单空洞重叠型**（典型）：空洞点 `got < expected`。空洞点之前 A 时间线的最后 `expected-got` 个事件是过期尾巴（通常以 `turn/end` + `session/end-seed` 收尾）；空洞点之后 B 从 `got` 继续且更长/更新。→ 删除 A 的那 `expected-got` 个事件，保留 B 完整尾部（删除后 seq 天然连续，无需重编号）
   - **多写入者交错型**：文件里两条时间线交错出现。按内容判定哪条是用户真实续聊（含后续 `user/message` 的才是真实线，往往是最后追加的），删除其余时间线的**全部**行
   - 判定不确定时**先问用户**，不要猜
4. **备份+修复**：`node scripts\repair-generic.mjs <日志文件> "<删除行范围>" <期望最后seq>`（行号为 1-based 含端点，多段用逗号，如 `"88-164,168,176-365"`；脚本自动备份原文件到本技能目录 `backup\`，删除后自动重扫断言 seq 连续）
5. **校验**：`node scripts\final-verify.mjs <日志文件>`；再跑一次 `scan-all.mjs` 确认全库无残留
6. **让用户回 Web UI 重开该会话确认**（运行时成功加载后会在尾部追加新事件，可作旁证）

## 安全规则（必须遵守）
- 先备份后修改（脚本自动做）；**绝不重编号 seq、绝不伪造缺失事件**，只删重叠/过期时间线
- 修复前确认文件 mtime 已停止变化（该会话不在活跃写入）；正在活跃写入的日志不要动
- 校验必须全绿才算完成；修复失败时从 `backup\` 恢复并重新分析
- Node ≥ 22（内置 zstd）；脚本为 ESM（.mjs），直接用 `node` 运行
- 本技能目录：`%USERPROFILE%\.agents\skills\session-log-repair\`

## 已修复案例（2026-08-17）
- `session-9403401a`：删除 18 个重叠事件（过期尾巴 80261..80278），保留新延续
- `session-00f377ba`：删除 3 个重叠事件（267130..267132）
- `session-07776fc8`：删除 4 个重叠事件（264786..264789）
- `session-bd0649c6`：三写入者交错，删除 268 行过期时间线（782 个事件），保留用户真实续聊（251 个事件）
