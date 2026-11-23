# 命令

31 个，按用途分七组。**大多数时候你只需要前两组。**

退出码：`0` 通过 / `1` 有 hard_fail、dirty **或未受控** / `2` 用法错误 / `3` 内部错误。

`guard` 是唯一例外：它的 `0` 表示「能直接继续」，`1` 表示「不能」（ask 和 deny 都算不能，区别在 JSON 的 `decision` 字段）。

---

## 建：把东西写进来

| 命令 | 做什么 |
|---|---|
| `new <id> --spec f.json [目录]` | 一条一条建。`--spec` 里给齐原文、引文、主张、出处、依据 |
| `set <id> <字段> <值>` | 改一个字段。两个字段必须同时改时用 `--patch '{"k1":v1,"k2":v2}'` |
| `import <id> --paper <目录> --claim "..." --quote "..."` | 从论文目录接。它会自己抽原文、算哈希 |
| `import <id> --code <目录> --claim "..." --quote "..." [--url 仓库地址]` | 从代码仓接 |
| `ingest <收件箱目录> [--into X] [--confirm]` | 把收件箱里的草稿整批搬进正式区 |
| `inbox [on\|off]` | 收件箱开关。开了之后 `new` / `import` 必须先落草稿 |

## 校：形状对不对

| 命令 | 做什么 |
|---|---|
| `check [目录] [--fix]` | 全库扫一遍，四态输出：`pass` / `fixed` / `dirty` / `hard_fail` |
| `fields` | 打印 28 个字段的契约（每个字段什么意思） |
| `fields --audit [目录]` | 字段审计：谁写、谁读、条目里有几种取值。找「写进去没人读」的死字段 |

## 判：这条还能不能用

| 命令 | 做什么 |
|---|---|
| `status <id> [目录]` | 读时重算：两个维度、三个答案、受不受控 |
| `trace [目录]` | 看留痕：哪些条目没入库记录、哪些被改过、链头对不对 |
| `trace [目录] --adopt --confirm` | 为没有记录的条目建基线（记 `adopt`）；**被改过的记 `drift`**，note 里带期望/实际哈希——「首次纳入」和「改过之后接受」是两回事 |
| `trace [目录] --reseal` | 重建链头。只在确认「改动是自己做的」之后跑 |
| `doctor [目录]` | 体检：物理隔离生效没有、留痕全不全、地图在不在 |

## 用：给人看、给 AI 看

| 命令 | 做什么 |
|---|---|
| `view [--out 文件]` | 导出只读证据册（HTML）。加 `--md` 出 Markdown，能进 diff 让导师批注 |
| `map [--out 文件 \| --json]` | 课程地图。`--json` 只出数据，给别人渲染 |
| `map --brief` | 生成「给 AI 的地图任务书」，可整段粘给 AI 让它帮你写地图 |
| `serve [--port 4321] [--open]` | 本地只读服务，刷新即当下（不落盘，每次现算） |
| `open` | = `serve --open`。最常用，记不住命令就用它 |

## 查：总账与对比

| 命令 | 做什么 |
|---|---|
| `stats [目录] [--json]` | 文档里要引用的数字，从库里现算一遍 |
| `review [目录] [--topic 话题] [--json]` | 同话题的主张并排看 |
| `projects ['workspace'] [--json]` | 多个库并排：各自几条、能引用几条 |
| `sources [目录] [--json]` | 看这个库靠哪些材料撑着；哪些材料被判可疑 |
| `log <项目>` | 插话日志：谁在什么时候打断了什么 |
| `index [目录]` | 生成 `INDEX.md`（条目清单） |

## 改：退役、恢复、补证据

| 命令 | 做什么 |
|---|---|
| `retire <条目> --reason "..." [--by <接替者>] [--confirm]` | 退役：留着，但不再当依据。`--undo` 撤销 |
| `deprecate <来源> --reason "..." [--confirm]` | 弃用一份**来源**，它下面所有主张都不再可引用 |
| `restore <来源> [目录]` | 恢复为「在用」 |
| `corroborate <id> --source <文件> --uri <地址> --quote "..."` | 补一条独立佐证（世界维度靠它） |
| `run <id> --script <脚本> --output <输出> --expect 键=值 [--input <上游产物>] [--cmd "..."] [--env "..."]` | 登记一次实测（世界维度的另一条路）。`--input` 可以给多次 |

## 扫：从外部材料找候选

| 命令 | 做什么 |
|---|---|
| `audit [目录] [--strict] [--all] [--json]` | **隐私自查**：扫密钥 / 邮箱 / 手机号 / 身份证 / 绝对路径。`--strict` 有命中就退 1 |
| `scan <目录> --project <项目> [--advise] [--commit] [--json]` | 扫外部材料，抽候选主张 |
| `advise --project <项目> --candidates <f.json>` | 把候选整理成建议（不替你做决定） |
| `draft <id> [--json]` | 从条文里抽 `check` 候选 |
| `rules` | 看规则文件 |
| `guard --target <路径> [--action write]` | 动手前问一次（**挂不上宿主，从没在真实动作上生效过**） |

---

## 最常用的五条

```bash
proofline new  2026-11-22-xxx --spec s.json entries   # 建一条
proofline check entries                               # 看看有没有坏的
proofline status 2026-11-22-xxx entries               # 这条现在还能不能用
proofline view                                        # 出一份证据册
proofline open                                        # 本地打开看看
```

## 八条命令的关系

`new` 写、`check` 校、`status` 判、`view` 用——这四步是主干。

`trace` 和 `doctor` 是给这四步做**诊断**的：前者查「东西是不是被抓过」，后者查「整个库有没有物理上的漏洞」。

`map` 和 `stats` 是给这四步做**汇报**的：一个说结构，一个说数字。
