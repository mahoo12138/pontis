# 22. 关键决策、不变量与术语表

## A. Architecture Decisions

| 主题 | V1 决策 |
|---|---|
| Canonical authority | Server |
| Client | Offline-capable replica |
| Sync | Operation-based `/sync` |
| Event Sourcing | No |
| Current State | SQLite canonical nodes |
| Incremental history | Short-lived Journal |
| Node Identity | UUIDv7 |
| Browser IDs | Client-local only |
| Node types | Folder / Bookmark |
| Ordering | integer position storage + before_id wire |
| Sync primitives | CREATE/UPDATE/MOVE/DELETE |
| UPDATE | one field per operation |
| DELETE Folder | recursive |
| Space owner | exactly one user |
| Shared collaborative Space | No V1 |
| Admin private content access | No product-level implicit access |
| Full Sync | whole profile ↔ one Space |
| Partial Sync | multiple non-overlapping folders ↔ multiple Spaces |
| Same Space multiple mounts | No V1 |
| Cross-space drag | atomic high-level transfer |
| Initial matching | strict parent-aware exact matching |
| URL normalization in sync | Never |
| Full Resync identity | Canonical UUID mapping |
| Recovery | protect new data, review stale destructive intent |
| Search V1 | scoped SQLite substring first |
| Backup | logical per-Space snapshot |
| Whole-space restore | epoch change |
| Job queue | SQLite persistent jobs |
| Scheduler | persistent SQLite state |
| User task surface | 独立「任务」页，聚合用户-owned schedules/jobs；领域页面仍是主要配置入口 |
| Admin task surface | 独立 `管理 / 后台任务` 页面，用于全局 Job/Worker 运维，不得隐藏在系统设置中，不暴露私人书签内容 |
| Generic task builder | No；用户只能创建注册过的领域 Task Definition |
| Job delivery | at least once |
| Undo | new inverse ChangeSet, never revision rollback |
| Telemetry | off by default |
| Backend | Go + chi + SQLite + handwritten SQL |
| ORM | None |
| Frontend | TS + React18 + React Router / TanStack Query + Mantine + Vanilla Extract |
| Mantine 版本 | 停在 7.17.8：不为 `TreeSelect` 跨两个大版本升级（见下方「Mantine 9 升级」决策） |
| Web Router | react-router-dom（见下方「路由栈」决策）；TanStack Router 不再并列 |
| Extension | TS + WXT + Dexie |
| Repository | monorepo server/web/extension/packages |
| Web production | dist embedded into Go binary |
| Settings IA | `设置` 仅承载当前用户个人设置；实例级能力进入独立 `管理` 区 |
| Admin IA | 管理员主导航固定提供 `用户` / `后台任务` / `系统设置` 三个一等入口 |

### 路由栈（2026-10-10）

**决策：Web 使用 react-router-dom。TanStack Router 从依赖中移除，不再"两套并存"。**

设计文档最初写的是 TanStack Router，实现从一开始就用 React Router：`web/src/app.tsx`
用 `BrowserRouter`，17 个路由全在 `web/src/routes/`。`package.json` 里同时列着
`@tanstack/react-router`，但源码没有任何一处 import 它——只是一个装了没用的包。

并存的成本不是抽象的：文档与依赖各说一套，读代码的人要猜哪套是权威的，而这类
"模块都有、调用链不通"正是本仓库上一轮的主要病因。

迁移到 TanStack Router（类型化 search params 是它真正的价值）如果要做，条件是：
作为独立分支，自带深链与 search params 的测试，且不夹带任何同步正确性修复。在
内部 Alpha 里它排不到前面。

### Mantine 9 升级（2026-10-20）

**决策：不为 `TreeSelect` 升级 Mantine。两端停在 7.17.8；升级若发生，独立立项，且不一次跨两个大版本。**

排查四处「从文件夹树里选一个文件夹」的界面时确认了两件事。第一，`TreeSelect` 从
`@mantine/core` 9.2.0 才有，而 9.x 的 peer 是 `react ^19.2.0`（8.x 仍接受
`^18.x || ^19.x`）——我们在 React 18.3，所以「换 TreeSelect」实际等于「先做 React
18→19」。第二，即便升上去它也顶不了那四处：single/multiple 模式**只有叶子节点可以
选中**（官方文档原文 "Only leaf nodes can be selected"），而选中一个含有子文件夹的
文件夹正是这里的常态；closed 字段显示祖先路径没有对应 prop；也不做虚拟化。9.x 里
真正可借的是 `useVirtualizedCombobox` 这个模式，不是 TreeSelect。

因此本轮改为：四处文件夹选择统一用可搜索 `Select`，**label 里带完整路径**——同名
文件夹由此可分辨，路径也带走了缩进本来表达的信息；标签输入换成 `TagsInput`
（`splitChars` 保住全角逗号）；两处用 JS 改 DOM style 做的 hover 换成 CSS 规则或主题
`Button`。评估全文（含 7→8、8→9 逐条对账与本仓库命中计数）见
`mantine-9-upgrade-assessment.md`。

将来若因别的原因升级，顺序是 7→8（低风险、React 18 下可做）→ React 19 → 8→9。

### 空标题书签与文件夹（2026-11-25，R14）

**决策：空标题（`""`）是合法的用户数据，Canonical Executor 与同步协议原样保留，不拒绝也不静默改写；Web 界面在展示层按 host / URL 或占位文案兜底。**

浏览器书签栏中“仅显示图标”的空标题书签非常常见，未命名文件夹亦受浏览器支持。此前 Canonical Executor 拒绝 `Title == ""`，导致含空标题书签的 Profile 在首次对账 commit 阶段 500、增量改名为空被静默丢弃。允许空标题后，浏览器快照、增量同步、HTML 导入导出与 Web 端保持双向无损一致。

### 映射丢失恢复（Mapping-Lost Recovery）中的仅本地节点（2026-11-25，R30）

**决策：Recovery 会话服务端不修改 Canonical Tree，也不为浏览器独有节点分配伪造的 `canonical_id`；步骤执行完成后，客户端将仍未建立映射的本地节点作为普通 `CREATE` 操作入队，通过后续增量 `/sync` 上传并获得正式规范身份。**

此前服务端 `StrategyPreserve` 为 `SourceOnly` 节点预分配随机 UUID 并发出 `assign_identity`，却在 `Commit` 时故意跳过写入 Canonical Tree，导致浏览器独有书签被贴上服务端不存在的伪 ID，后续任何修改或移动都会触发 `NODE_NOT_FOUND` 且永远无法上传。明确将 `StrategyPreserve` 的 `SourceOnly` 节点标记为 `LocalOnly`（不下发 `assign_identity`，且不作为 `before_id` 锚点），由客户端在 `finish()` 后统一走标准 `CREATE` 管线上传，同时保留尚未采纳的已有出箱 `CREATE`，避免重复创建与数据丢失。

### 删除目录与同子树并发新建的对称保护（2026-11-25，R15）

**决策：删除目录与并发新建无论哪一方先到达服务端，新数据都不得静默丢失；服务端 `decideDelete` 在删除目录前将 `created_revision > op.BaseRevision` 且非同绑定因果前驱的新建子节点移入 `recovered:<device>` 根槽，客户端 `applyDelete` 在递归删除前抢救未上传的本地新建节点，同时客户端必须将 `recovered:*` 根槽投影为挂载目录下的可见 `Recovered` 文件夹。**

此前仅在“先删后建”时触发 `decideCreate` 恢复，若“先建后删”则 `decideDelete` 直接递归删除整个目录，违背不变量 B.10；客户端此前也将 `recovered:*` 当作 `excluded` 静默丢弃，导致被服务端抢救的数据在浏览器不可见。双向对称抢救与可见投影后，任意同步时序下离线新建书签均可完整保留并被用户看到。

## B. Sync Invariants

1. Canonical State + Revision + Journal + Receipt 必须原子提交。
2. 一个 Space 的 Canonical Changes 有严格线性 revision 顺序。
3. Client Operation 通过 op_id 幂等。
4. Canonical Change 通过 `(epoch, revision)` 唯一。
5. received_revision 只能推进到已经完整持久化的连续 Inbox。
6. applied_revision 只能推进到 Browser 实际确认的连续 Changes。
7. HTTP success 不等于 Pending 可删除。
8. same Binding Canonical Change 严格按 revision 串行 Apply。
9. DELETE 不允许 stale UPDATE/MOVE resurrection。
10. offline-created new data 不得静默丢失。
11. normal incremental identity 永远基于 Canonical UUID，不使用 URL 重新识别。
12. active reconciliation 时 network sync 可暂停，但 local Browser Event Capture 不能暂停。
13. old-epoch Pending 不得原样 replay。
14. Full/Initial/Recovery Verify 成功后才进入 ACTIVE。
15. Server committed reconciliation 不因 Browser apply failure 回滚 Server。
16. Operation 的 epoch / floor / client_seq 判定读取自它写入的那个事务；事务外的读取只能提前拒绝，不能放行写入。
17. `max_client_seq` 与 Receipt 同一事务消费；水位写回不携带它。
18. 一个回包的 head、floor 与 Change 页，以及 Snapshot 的 revision 标签与树，各自来自同一个读快照。
19. Operation 一旦发出，其 payload 即不可变（含响应丢失后的重试）；之后的编辑是新的 Operation，按 client_seq 排在它之后。只确定从未发送过的 Operation 可以原地合并。
20. 恢复成功必须证明 Browser 达到了 Server 要求的状态：来自完整 Snapshot/Plan 的 Verify，而不是"本地两张表互相一致"或"队列为空"。
21. Epoch 换代（备份恢复）后，旧 epoch 的 Reconciliation Session 一律失效；commit/complete 在写事务内复核 session 的 target epoch 与 binding epoch，不能只靠恢复入口清理。

## C. Domain Invariants

1. 每个 Node 恰好属于一个 Space。
2. 每个 Node 恰好一个 ParentRef：Node 或 RootSlot。
3. Parent Node 必须 Folder。
4. Node type immutable。
5. Bookmark url 非 NULL；Folder url NULL。
6. Folder 不能 parent=self/descendant。
7. Ordering 是用户数据。
8. Sibling position renumber 不代表 sibling semantic move。
9. Canonical Tree mutation 不可绕过 Domain Executor。

## D. Privacy / Security Invariants

1. Private resource exactly one owner。
2. Admin role ≠ private bookmark reader。
3. Token authority ⊆ owner user authority。
4. Device Credential 只作为该 Device Replica。
5. Cross-user content transfer 必须显式通过 Publication Copy。
6. Resource ID 永远不是 authorization capability。
7. Bookmarklet 不得在 Web UI Origin 执行。
8. Diagnostics/Logs 默认不记录完整 private URL/title/secrets。
9. Host/proxy headers 默认不可信。
10. Logical Bookmark Backup 不包含 Server credentials。

## E. Task / Job Invariants

1. Schedule 与 Job 是两个不同对象：Schedule 决定何时产生 Job；Job 表示一次实际执行。
2. `owner_user_id != NULL` 表示 User Task；`owner_user_id == NULL` 表示 System Task。
3. 用户级「任务」页面只展示当前用户拥有的领域任务，不暴露 Generic Job Infrastructure。
4. 用户任务配置优先归属领域页面；任务中心提供跨 Space 聚合、状态与统一管理。
5. 管理员「后台任务」页面是运维视图，不赋予 Private Bookmark Reader 权限。
6. Pause/Delete Schedule 不自动取消已经创建或正在运行的 Job。
7. 普通用户不能提交任意 Job Type / Payload / Cron，只能使用已注册的 User-visible Task Definition。


## F. Information Architecture Invariants

1. 「设置」表示当前用户自身配置，只包含账户、偏好、API Token 等个人范围内容。
2. 「系统设置」表示实例级配置，只对管理员开放；不得与普通用户设置混在同一个 Tab 组中。
3. 「用户管理」与「后台任务」是独立管理对象，不属于「系统设置」的子按钮或隐藏入口。
4. 管理员登录后，主导航必须出现稳定的「管理」区域，并直接提供 `用户 / 后台任务 / 系统设置` 三个入口。
5. 非管理员完全不渲染「管理」导航，同时 Server API 仍必须执行管理员权限校验；隐藏 UI 不能替代授权。
6. 页面导航必须按“对象/任务”划分，而不是按“谁能访问”把不相关功能塞进「系统」。
7. 允许在系统设置页面提供指向用户管理、后台任务的上下文快捷链接，但快捷链接不能成为这些页面唯一的可发现入口。
8. 用户级「任务」与管理员级「后台任务」必须在命名、路由与页面语义上保持区分。

## G. Retention Invariants

1. Journal/Tombstone/Receipt 共享历史安全边界。
2. Old offline Device 不无限阻止 Journal GC。
3. Backup 是用户资产，不按普通 Job retention 粗暴删除。
4. 新 Backup 成功后才执行 retention cleanup。
5. Protected Backup 永不自动删除。
6. 最后一份成功 Backup 不自动删除。
7. Undo retention 与 Journal retention 独立。

## H. 术语

### Canonical Tree
Server 权威 Bookmark Tree。

### Sync Space
独立 Canonical Bookmark universe。

### Device
一个 Browser Profile 中的一次 Extension Installation。

### Binding
Device × Space 的同步状态单元。

### Mount
Client-local browser folder/root 与 Binding 的映射。

### Operation
Client 提交的本地意图。

### Canonical Change
Server 已提交的权威事实。

### Journal
可 GC 的 Canonical Change 增量历史。

### Tombstone
记录近期已删除 Canonical Node identity 的同步辅助数据。

### Receipt
Client Operation 幂等处理记录。

### ChangeSet
面向用户业务语义的一次 Canonical 修改集合。

### Reconciliation
两个 Tree/Replica 在非普通增量情境下重新建立一致性的流程。

### Initial Sync
第一次建立 Browser ↔ Canonical identity。

### Full Resync
identity 可信但增量 continuity 断裂时重新建立 baseline。

### Recovery
continuity/identity 有风险且存在可能丢失本地数据时的保守重建流程。

### Publication
用户显式发布的独立分享树快照/版本，不是 Private live reference。

### Safety Backup
高风险操作前系统自动生成的短期保护备份。
