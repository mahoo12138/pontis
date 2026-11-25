# Pontis 代码评审与风险清单

评审日期：2026-11-24。仓库：Mahoo12138/pontis。基线：main 的 `08360c259be10228c28ef7d3b47c7e24c5ea4527`（2026-11-07 23:29 CST，「docs: OIDC 单点登录与配对码设计文档（25）」），评审时工作区没有晚于该提交的改动。

上一轮评审（2026-10-09，基线 `6c99a8d`）的原文见 `git show 08360c2:review.md`；其 R01–R12 的当前状态列在 §2，新发现从 R13 起编号，避免与 [next-development-plan.md](next-development-plan.md) 中的引用冲突。R13–R24 来自第一遍通读（同步核心、扩展与服务端加固）；R25–R50 来自同日对认证、对账引擎、导入导出 / 撤销 / 广场、任务系统四组模块的第二遍深入阅读。

## 1. 结论与验证范围

**架构方向正确，不需要推倒重来；上一轮的 P1 问题基本已修复。当前风险分三类：扩展与真实浏览器的交互边界（R13–R20）；对账引擎的非首次路径基本走不通（Full Resync、Mapping-lost Recovery、歧义作答，R29–R32）；以及认证面的两处账户劫持（R25、R26）。在 R13、R14、R29、R30 修复前，仍不建议把真实书签库交给它作为唯一副本；在 R25–R28 修复前，不建议开启 OIDC 或开放注册。**

值得保留的基础：

- **协议设计**：Server 权威、客户端自分配 UUID、字段级 revision、同 Binding 因果判定、op receipt 幂等、epoch 换代。`processOperation` 在写事务内重读 binding/space 后再判定，响应的 head 与 change 页来自同一读快照（[sync/service.go](server/internal/sync/service.go)）。
- **扩展一致性模型**：持久化 outbox、调用浏览器 API 前先写 expected mutation、ensure-state、每 Binding 运行锁、崩溃后 recover；映射缺失时抛 `UnmappedProjectionError` 而不是推进 applied。
- **安全基线**：Argon2id、token 只存哈希、带 Cookie 的写请求校验 Origin；Link Check 出站策略对每个解析结果校验、直接拨已校验地址、每跳重定向重验、禁用代理（[organizer/outbound.go](server/internal/organizer/outbound.go)）。
- **一次性凭据与关键状态转移**：密码重置、配对码、OIDC state 都是“SELECT + 带条件的 UPDATE/DELETE”在同一事务里判胜负；reconcile 的 Complete 在写事务内复核 epoch，`FinalizeBinding` 带 epoch 条件；调度用 `(schedule_id, scheduled_for)` 部分唯一索引去重，崩溃不重复也不丢；失效链接删除在写事务内复核 URL 与 revision。
- **测试取向**：reconcile property test、syncsim 收敛模拟、race、golden fixture、CI 中两个真实 Chromium Profile 收敛。

本次为**静态阅读**：读取了本地工作区的 server/internal、migrations、extension/src、web/src、packages 与 docs。本机缺少命令行开发工具，**没有运行 Go/TypeScript 测试、构建或真实浏览器 E2E**，也没有执行 git 命令（基线由 `.git` 目录直接读取）。R13 的浏览器行为依据为公开资料与社区确认的 Chrome 行为，尚未在真实 Profile 中复现。第二遍深入阅读按模块并行进行，每条发现都要求追到代码行并给出可触发场景；各模块的关键结论已逐条对照代码复核。标注“疑似”的条目仍需要用测试复现。

优先级约定同上一轮：P1 为真实数据/主流程/多用户安全必须先修的问题；P2 为产品闭环前需补的实现缺口与工程风险；P3 为工程卫生。

## 2. 上一轮问题状态

| 编号 | 主题 | 状态 | 依据 |
|---|---|---|---|
| R01 | 新设备初始化不可达 | 已修复 | reconciliation create/commit/complete 已接入 HTTP，complete 是 binding 变为 active 的唯一路径（[httpapi/reconcile.go](server/internal/httpapi/reconcile.go)） |
| R02 | 空 operations 响应为 null | 已修复 | `handleSync` 显式 `make(...)`，并有 [sync_contract_test.go](server/internal/httpapi/sync_contract_test.go)；扩展端有运行时校验（[protocol/validate.ts](extension/src/core/protocol/validate.ts)） |
| R03 | 删除契约不一致 | 已修复 | 适配器拆为 `removeBookmark`/`removeSubtree`，fake 按真实 API 拒绝非空目录 remove |
| R04 | 未执行的变化推进 applied | 已修复 | 缺失映射抛 `UnmappedProjectionError`，`excluded` 与 `missing` 分开 |
| R05 | 排序执行与崩溃恢复 | **部分修复** | create 已传 index、ID 命名空间已分清、recover 检查 rank；**同父下移的 index 语义仍错，见 R13** |
| R06 | 备份文件名碰撞与目录逃逸 | 已修复 | opaque UUID storage key（[000018](server/migrations/000018_backup_storage_keys.sql)、[backup.go](server/internal/backup/backup.go)） |
| R07 | 恢复写入顺序与基线 | 已修复 | `orderParentFirst` + 完整校验，revision/stamps 归 0，epoch 在写事务内分配，旧 epoch reconciliation 置 failed |
| R08 | 禁用账户未覆盖设备凭据 | 已修复 | `requireDevice` 返回 `ACCOUNT_DISABLED` |
| R09 | Link Checker SSRF | 已修复 | 见 §1 |
| R10 | API Token 未接入认证 | 已修复 | `requireScope` + `requireSpaceAccess`，token 与 session 按前缀区分 |
| R11 | 同步事务边界 | 已修复 | 写事务内重读，`ReadTx` 统一读快照 |
| R12 | Link Check 内存任务 | 已修复 | 走 Job System（[organizer.go](server/internal/organizer/organizer.go#L153)），结果持久化（[000019](server/migrations/000019_link_check_runs.sql)） |

## 3. 关键发现

### 3.1 同步核心、浏览器扩展与服务端加固

#### R13 · P1 · 同一父目录内向后移动，在真实 Chrome 上落位错误

Chrome 的 `bookmarks.move` 在同父目录、目标 index 大于当前位置时，按**移除前**的下标解释：目标位置会比预期靠前一格（[社区确认](https://stackoverflow.com/questions/13264060/chrome-bookmarks-api-using-move-to-reorder-bookmarks-in-the-same-folder)）。

`browserIndexForPosition` 与 `indexForBefore` 都先把被移动节点从兄弟列表中排除，算出的是**移除后**的下标；Chromium 适配器原样转发。于是：

- [A,B,C] 把 A 移到末尾，得到 [B,A,C]；
- 把 A 移到 B 之后（移除后下标 1），Chrome 视为原地不动，什么也不发生。

测试没有发现，是因为 `fakeChromeBookmarks` 与 `FakeAdapter` 都按“先移除再插入”实现，比真实 API 更理想——正是 R03 描述过的“Fake 比真实更宽松”。镜像 position 随后从 `readOrder` 读回，所以错误会以 order_drift 的形式出现，而 `integrityCheck` 把 order_drift 排除在严重问题之外，最终表现为“同步成功、顺序不对”。

修复：在 Chromium 适配器内统一换算（同父且 index > 当前下标时 +1），核心代码只表达“移除后的目标下标”这一种语义；fake 改为 Chrome 的真实语义；Firefox 适配器将来按其自身语义各自换算。

验收：adapter contract test 覆盖同父上移、下移、移到末尾、移到紧邻下一个之后；Fake 与真实包装器跑同一套用例；双 Profile 中一端下移、另一端顺序一致。

代码依据：[remoteChangeApplier.ts#L534](extension/src/core/sync/remoteChangeApplier.ts#L534)；[reconcileSteps.ts#L352](extension/src/core/sync/reconcileSteps.ts#L352)；[chromium.ts#L100](extension/src/core/browser/chromium.ts#L100)；[fakeChromeBookmarks.ts#L139](extension/src/testing/fakeChromeBookmarks.ts#L139)；[fakeAdapter.ts#L152](extension/src/core/browser/fakeAdapter.ts#L152)。

#### R14 · P1 · 空标题书签使首次同步整体失败，增量编辑被静默丢弃

Chrome 允许空标题，书签栏里“只显示图标”的书签很常见。Canonical Executor 拒绝 `Title == ""`（create 与 update_title），扩展与 reconcile 都不做替换：

- **首次对账**：`ClientSnapshotJSON.Tree()` 不校验标题，计划照常生成；`Commit` 把整份计划放在一个事务里执行，任一空标题节点返回 `ErrTitleRequired`，落入 `writeReconcileError` 的 default 分支变成 500。该 Profile 永远无法完成初始化，用户只看到 internal error。
- **增量同步**：CREATE 或改名为空被判 `invalid_payload`，结果随后被静默清理（见 R16）。

修复：二选一并写入 ADR。推荐把空标题当合法用户数据（去掉执行器限制，Web 端展示用 URL/host 兜底）；若坚持非空，必须定义双向一致的规范化（上传替换、回流不再改写浏览器），并在 snapshot 提交阶段返回可读错误，而不是在 commit 时 500。

验收：含空标题书签的 Profile 完成首次同步；在另一端改名为空、再改回，两端一致且不产生 pending 残留。

代码依据：[executor.go#L127](server/internal/canonical/executor.go#L127)、[#L206](server/internal/canonical/executor.go#L206)；[reconcile/artifact.go#L41](server/internal/reconcile/artifact.go#L41)；[reconcile/service.go#L895](server/internal/reconcile/service.go#L895)；[httpapi/reconcile.go#L249](server/internal/httpapi/reconcile.go#L249)。

#### R15 · P1 · 删除与并发新建落在同一子树时，新数据丢失或不可见

doc 22 B.10 要求离线新建数据不得静默丢失，但删除路径两端都没有守住：

1. **Server**：`decideDelete` 不看 `base_revision`，直接递归删除。另一设备在该 base 之后向此文件夹新建的书签会被一并删除。若顺序相反（先删后建），create 会进入 `Recovered/<设备>`。同一组意图，结果取决于到达顺序。ChangeSet 撤销可以挽回，但用户无从知道需要撤销。
2. **Client**：`applyDelete` 对远端 DELETE 直接 `removeTree`，会连带删掉本机尚未上传的子节点。其 QUEUED create 随后上传，因父目录已有 tombstone 而被放入 `recovered:<device>` root slot；而 `resolveParent` 对 mount 不认识的 root 返回 `excluded`，扩展也没有任何处理 `RECOVERED` 的代码。结果是这个书签从浏览器消失，只在 Web 工作台的根目录列表里存在，没有任何提示。

修复：Server 删除前检查子树中 `created_revision > base_revision` 且来源不是本 Binding 的节点，把它们移入 Recovered 或将整个 DELETE 判为 conflict（写进 ADR）。Client 删除前先把带未结算 create 的子节点移出待删子树。Recovered root 要么投影到浏览器的固定文件夹，要么在 popup 与 Web 给出明确通知。

验收：A 删除文件夹（base 较旧）、B 同时在其中新建，两种到达顺序结果一致且 B 的书签可见；本机在文件夹中新建未上传时收到远端删除，书签保留并可见。

代码依据：[sync/decide.go#L250](server/internal/sync/decide.go#L250)；[executor.go#L426](server/internal/canonical/executor.go#L426)；[remoteChangeApplier.ts#L457](extension/src/core/sync/remoteChangeApplier.ts#L457)、[#L502](extension/src/core/sync/remoteChangeApplier.ts#L502)。

#### R16 · P1 · 被拒绝、冲突、恢复的操作结果全部静默丢弃

`recordResult` 只把 pending 标为 RESOLVED，`settlePending` 到 settle 修订号即删除；没有诊断日志，也没有界面展示。只有跨空间搬运使用了 `keepResolved`。CONFLICT 时浏览器会被远端值覆盖，用户的编辑消失而无任何痕迹。

更严重的连锁：被拒绝的 CREATE 留下一条 `canonicalId = null` 的镜像。此后对该节点的编辑走“未映射本机节点的改动已丢弃”分支；`shouldSkipUpload` 因镜像存在而跳过，完整性检查也不会重新上传。这个书签从此永久不同步，状态仍显示正常。

修复：REJECTED/CONFLICT/RECOVERED 写入诊断，并在 popup 的同步状态中可见（与下一阶段计划“同步状态清楚展示”合并）；被拒绝的 CREATE 要么清掉镜像使其可被重新上传，要么进入 `waiting_user` 让用户处理。

验收：构造被拒 CREATE 与同字段并发冲突，用户能在扩展中看到结果；修正后的书签能重新同步上去。

代码依据：[syncCoordinator.ts#L359](extension/src/core/sync/syncCoordinator.ts#L359)、[#L372](extension/src/core/sync/syncCoordinator.ts#L372)；[eventProcessor.ts#L256](extension/src/core/sync/eventProcessor.ts#L256)；[verifyReplica.ts#L82](extension/src/core/sync/verifyReplica.ts#L82)。

#### R17 · P1 · 部分同步模式下，拖入、拖出挂载目录都不会被捕获

- **拖入**：外部节点没有镜像，`isManagedScope(node.id)` 沿镜像向上找不到挂载根，事件被忽略。只能等完整性检查补传，而完整性检查实际上很少运行（R18）。
- **拖出**：节点镜像仍指向旧父目录，判定为受管范围；但新父目录不可映射，`canonicalParentRef` 返回 null，只记 warn 后忽略。服务端与其他设备会永久保留该节点。

修复：`handleMoved` 用 `oldParentId` 与新 `parentId` 分别判断进出；拖入按整棵子树新建处理，拖出按 DELETE（或另一 Binding 的跨空间搬运）处理。

代码依据：[eventProcessor.ts#L296](extension/src/core/sync/eventProcessor.ts#L296)、[#L316](extension/src/core/sync/eventProcessor.ts#L316)、[#L376](extension/src/core/sync/eventProcessor.ts#L376)、[#L559](extension/src/core/sync/eventProcessor.ts#L559)。

#### R18 · P2 · 扩展的周期 alarm 基本不会触发

`chrome.alarms.create` 遇到同名 alarm 会取消并替换它，计时归零。background 每次 service worker 启动都无条件重建三个 alarm，而 1 分钟的 `pontis-activity-hb` 本身会不断唤醒 worker（空闲约 30 秒即被回收），于是 5 分钟的 `pontis-sync` 与 24 小时的 `pontis-integrity` 一直被重置。同步还能靠启动时的 `runSync('wake')` 兜底；完整性检查实际只在浏览器启动时运行。

修复：先 `chrome.alarms.get(name)`，不存在或周期不符时才创建。

代码依据：[background.ts#L104](extension/src/entrypoints/background.ts#L104)。

#### R19 · P2 · 全量同步模式的修复路径为空

`verifyAndRepair` 只处理 partial 模式（`repairLevel` 与 `uploadPassAll` 都要求 `folderBrowserId`）。全量模式下发现 missing mirror 或字段漂移不会排出任何修复 op，`integrityCheck` 的结果只能是 `ok`、`mapping_lost` 或 `failed`，不可能是 `repaired`。

代码依据：[verifyReplica.ts#L106](extension/src/core/sync/verifyReplica.ts#L106)、[#L125](extension/src/core/sync/verifyReplica.ts#L125)；[integrity.ts](extension/src/core/sync/integrity.ts)。

#### R20 · P2 · 远端新建按“标题 + URL”采用本机新建，可能产生重复书签

`tryAdoptLocalCreate` 的第三级兜底会把任何同标题、同 URL 的未结算本机 create 认作“这条远端 change 的生产者”。两台设备同时收藏同一页面时：本机镜像被挂上对方节点的 canonical id；本机 create 仍按自己的 nodeId 上传，服务端产生第二个节点，回流时已无可采用的镜像，于是浏览器里多出一个书签。

客户端自分配 UUID 之后，按 `nodeId` 匹配已经足够；`resultRevision` 与形状匹配两级兜底应删除。

代码依据：[remoteChangeApplier.ts#L302](extension/src/core/sync/remoteChangeApplier.ts#L302)、[#L318](extension/src/core/sync/remoteChangeApplier.ts#L318)。

#### R21 · P2 · 服务端缺少请求资源上限

- `decodeJSON` 没有 `http.MaxBytesReader`；`http.Server` 只设了 `ReadHeaderTimeout`，没有 Read/Write/Idle timeout。
- 单个 `/sync` 请求的 operations 数量没有上限，客户端也会把全部 QUEUED + IN_FLIGHT 一次发出。大量离线编辑会形成一个超大请求，在单连接池上长时间独占写入（R22）。
- login、register、pair、reset 没有限流或并发上限。每次 Argon2id 校验占 64 MiB，匿名并发登录即可耗尽小机器内存；配对码 40 bit 加 10 分钟有效期本身足够，但同样没有尝试次数限制。

修复：全局 body 上限（按路由放宽导入）、完整的服务端超时、每轮 op 数上限（客户端分批、服务端拒绝超限）、认证类接口的全局与按账户限流，以及 Argon2 并发信号量。

代码依据：[httpapi/server.go#L400](server/internal/httpapi/server.go#L400)；[app/app.go#L219](server/internal/app/app.go#L219)；[auth/password.go#L15](server/internal/auth/password.go#L15)；[syncCoordinator.ts#L220](extension/src/core/sync/syncCoordinator.ts#L220)。

#### R22 · P2 · 单连接池让所有请求串行，且容易自锁

`SetMaxOpenConns(1)` 让读请求也排队：大树 snapshot、导出、备份会阻塞所有用户的 `/sync` 和页面加载。多处代码注释已经在提醒“事务里不能再要第二个连接”（例如 reconcile `Commit` 预读的那段），说明这是一个靠人工纪律维持的约束：任何路径在事务中误用 `s.db`，就会永久阻塞。

修复：写连接保持 1 个；另开一个 WAL 下的只读连接池给 `BeginReadTx` 与纯读查询使用。再加一条测试：在持有写事务时，任何 store 方法不得调用 `db` 本身（可用带超时的 ctx 检测）。

代码依据：[store/sqlite/sqlite.go#L36](server/internal/store/sqlite/sqlite.go#L36)；[reconcile/service.go#L829](server/internal/reconcile/service.go#L829)。

#### R23 · P2 · 管理员授权分散在各 handler 内

`/api/v1/admin/*` 与普通会话路由放在同一个 group 里，管理员判断由每个 handler 自行调用 `requireAdmin`。目前逐个核对均已覆盖，但新增一个 admin handler 时漏写一行就是越权，且测试只能逐条补。建议把 admin 路由放进独立 group，在路由层用中间件统一判断。

代码依据：[httpapi/server.go#L166](server/internal/httpapi/server.go#L166)、[#L187](server/internal/httpapi/server.go#L187)；[httpapi/admin.go#L16](server/internal/httpapi/admin.go#L16)。

#### R24 · P2 · 运行锁租期固定 5 分钟且不续期

`acquireRunLock` 只在获取时写 `takenAt`。一轮超过 5 分钟的同步或对账（大树首次同步、慢网络）会被下一个触发者视为过期而接管，两轮并发处理同一 inbox，正是锁要防止的情况。worker 启动时 `releaseAllRunLocks` 已覆盖“上一个 worker 被杀”的场景，因此可以在长任务的每个阶段续期，或改为按 worker 实例标识判断持有者。

代码依据：[store/db.ts#L431](extension/src/core/store/db.ts#L431)。

### 3.2 认证与账户

#### R25 · P1 · OIDC 回调不读取 state cookie，可做登录 CSRF，把受害者的书签同步进攻击者账户

`handleOIDCStart` 写入 `pontis_oidc` cookie，但 `handleOIDCCallback` 只把 `?state=` 交给 `CompleteCallback` 查库消费，从不调用 `r.Cookie(OIDCStateCookie)`；整个 `internal/` 里这个 cookie 只出现在 oidc.go，测试也从没断言过它。PKCE verifier 与 nonce 都挂在这一行 state 上，所以一组 `state + code` 交给任何浏览器都能完成登录。doc 25 承诺的“state 同时出现在 authorize URL 与 HttpOnly cookie 里，服务端比对两者”没有实现。

场景：攻击者 M 访问 `/api/v1/auth/oidc/start`，用自己的 IdP 账号登录，在跳回之前截下 `callback?code=C&state=S`，10 分钟内把链接发给受害者 V（一次 GET 顶层导航即可）。服务端消费 S、换到 token、nonce 也对得上，于是给 V 种下 **M 账号的 session**。之后 V 在“设备”页生成配对码、配好扩展，首次同步会把 V 浏览器里的全部书签合并进 M 的 Space。

修复：回调读取 `pontis_oidc`，缺失即 `OIDC_STATE_INVALID`；用常数时间比较与 `?state=` 比对，不一致时**不要消费** state 行（否则攻击者能借此烧掉受害者正在进行的流程）。补一条“不带 cookie 的回调必须失败”的集成测试。

代码依据：[httpapi/oidc.go#L41](server/internal/httpapi/oidc.go#L41)、[#L62](server/internal/httpapi/oidc.go#L62)；[auth/oidc.go#L173](server/internal/auth/oidc.go#L173)；[docs/25-oidc-sso.md#L59](docs/25-oidc-sso.md#L59)。

#### R26 · P1 · SSO 首次登录按本地 email 自动关联，而本地 email 可被任何用户随意填写，可抢占同事的 SSO 身份

`resolveAccount` 在没有已知 identity 时，用 IdP 的 verified email 按 `email_normalized` 查本地账号，查到就写入不可更改的 `oidc_identities` 行。doc 25 只防了“IdP 侧未验证的 email”，却把本地 email 当成可信锚点；而 `PATCH /auth/me` 允许把 email 改成任意字符串（无格式校验、无所有权证明），开放注册时也可随意填写，doc 09 写明 V1 没有 email 验证。`UpsertOIDCIdentity` 的 ON CONFLICT 只更新时间戳，关联一旦写入只能手工改库。

场景：实例开启 OIDC。已有用户 Mallory 把自己的 email 改成 `alice@corp.com`（或在开放注册时直接用它注册）。新同事 Alice，或刚启用 SSO 时尚未登录过的老同事，第一次点“使用 SSO 登录”，IdP 返回 verified 的 alice@corp.com，被永久关联到 **Mallory 的账号**。Alice 此后的书签、设备、浏览统计都进了 Mallory 的账号，Mallory 用密码登录即可读取。无论 auto_provision 开关如何都会发生。

修复：首选取消按 email 的静默关联，改为“已登录的本地会话在设置页发起关联 SSO”的显式流程；次选只关联 `email_verified_at` 非空的账号（仅由 admin 建号或 SSO 开通写入，自助改 email 时清空）；至少让自助改过 email 或经开放注册建立的账号不参与关联。

代码依据：[auth/oidc.go#L265](server/internal/auth/oidc.go#L265)；[httpapi/account.go#L220](server/internal/httpapi/account.go#L220)；[store/sqlite/account.go#L23](server/internal/store/sqlite/account.go#L23)；[httpapi/server.go#L479](server/internal/httpapi/server.go#L479)。

#### R27 · P2 · 密码登录等公开 POST 没有 Origin 校验，`text/plain` 表单即可登录 CSRF

`sameOrigin` 只在 `requireSession` 的 cookie 分支生效；login、register、reset、setup 都不做 Origin 检查，`decodeJSON` 也不检查 Content-Type。跨站页面用 `<form enctype="text/plain">` 构造一个字段，name 为 `{"username":"mallory","password":"pw`、value 为 `"}`，浏览器发出的 body 正好是 `{"username":"mallory","password":"pw="}`，攻击者把自己的密码设成以 `=` 结尾即可通过 `DisallowUnknownFields`。这是简单请求，不触发预检；响应里的 Lax 会话 cookie 在顶层导航中会被保存。后果与 R25 相同，且覆盖未启用 OIDC 的实例。

修复：对所有公开的状态变更端点执行 `sameOrigin`（Origin 缺失时沿用现有策略）；`decodeJSON` 强制 `Content-Type: application/json`，把跨站请求推进预检。

代码依据：[httpapi/server.go#L549](server/internal/httpapi/server.go#L549)、[#L400](server/internal/httpapi/server.go#L400)、[#L661](server/internal/httpapi/server.go#L661)。置信度：服务端代码已确认，建议用 e2e 验证一次浏览器侧行为。

#### R28 · P2 · `/auth/setup` 先检查后插入，中间隔着 Argon2 哈希，并发初始化会产生两个管理员

`CountUsers == 0` 的判断与 `CreateUser` 之间没有事务或锁，中间还夹着几十毫秒的 Argon2id（64 MiB）；单连接池（R22）只把单条语句串行化，不能让“检查后插入”变成原子操作，users 表也没有约束能限定只有一个 admin。新实例刚暴露到公网时，两个用户名不同、几乎同时到达的 setup 请求都读到 0 行，都得到 `role=admin` 与 201。用户名相同的并发请求则撞上 UNIQUE 约束，`mapAuthError` 不认识这个错误，返回 500。

修复：先算好哈希，再在 `BEGIN IMMEDIATE` 的短事务里 `SELECT COUNT(*)` 后 INSERT，或用 `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM users)` 并检查 RowsAffected；顺带把 UNIQUE 冲突映射为 `ErrUserExists` / `ErrEmailTaken`。

代码依据：[httpapi/server.go#L441](server/internal/httpapi/server.go#L441)；[auth/service.go#L87](server/internal/auth/service.go#L87)；[store/sqlite/auth.go#L41](server/internal/store/sqlite/auth.go#L41)。

### 3.3 对账引擎

#### R29 · P1 · Full Resync 的身份步骤无法解析，binding 永久卡在 needs_recovery

Full Resync 调用 `MatchByCanonicalID(serverTree, clientTree)`，source 是服务端树，所以期望树里每个节点的 `SourceRef` 都是 canonical UUID。`DeriveClientSteps` 却拿它去客户端树（键是 `l_N`）的 `idx.byRef` 里查，永远查不到，于是给**每个**节点都发一条 `assign_identity{local_ref: <uuid>}`。扩展端 `scope.localRefs[uuid]` 为 undefined，第一步就抛 `StepResolutionError`。

场景：设备离线超过 journal 保留期，收到 HISTORY_EXPIRED，没有待发 op，走 `runFullResync`。服务端 plan/commit 成功；客户端拉 steps，第一条失败，binding 退回 needs_recovery。此后每一轮都是 resume → 拉 steps → 失败，无限循环，这台设备再也收不到其他设备的变更；每轮还会写一份全树 emergency snapshot，IndexedDB 持续膨胀。

测试没发现：property test 直接手工构造期望树；`TestReconcileFullResyncFlow` 只断言了 delete step；扩展端 resync 测试用的是假 driver。

修复：resync 的身份对应走 target 侧，即 `match.BySource[d.SourceRef]` 得到的客户端 ref；客户端节点已带同一 canonical id 时跳过；server-only 节点交给 create step，不发 assign_identity。补一条用服务端真实 steps 驱动 `applyReconcileSteps` 的端到端测试。

代码依据：[reconcile/service.go#L572](server/internal/reconcile/service.go#L572)；[desired.go#L234](server/internal/reconcile/desired.go#L234)；[steps.go#L52](server/internal/reconcile/steps.go#L52)；[reconcileSteps.ts#L97](extension/src/core/sync/reconcileSteps.ts#L97)；[reconcile_test.go#L412](server/internal/store/sqlite/reconcile_test.go#L412)。

#### R30 · P1 · Mapping-lost Recovery 给浏览器独有节点分配“幽灵 id”，并删掉它们排队中的 create

Recovery 用 `MatchExact` + `Preserve`。浏览器独有节点是 SourceOnly，`BuildDesired` 给它分配新 UUID F；但 recovery 的服务端 plan 被强制置空，F 从未写进 canonical。客户端 steps 里却有 `assign_identity(local → F)`，照办后 mirror 带上了 F。`finish()` 再调 `settleAdoptedCreates`：该节点在 outbox 里的 QUEUED create 一看 mirror 已有 canonicalId，就被当作“已被对账采纳”删除。注释说“由 Recovery Intent review 保护”，但 `recoverMapping` 这条路径不经过 intent review（resync.ts 的 review 只针对 FULL_RESYNC）。

场景：用户离线新建书签 B，outbox 里有 create。完整性检查发现缺失 mirror 超过 30%，走 `recoverMapping`。服务端不创建 B，客户端把 B 映射到 F 并删掉 create，binding 变为 active。B 永远不会上传；之后对 B 改名发出 `update_title(F)`，服务端报不存在（再叠加 R16 的静默丢弃）。违反 doc 22 B.10。

修复：recovery 的 source-only 节点不发 assign_identity，保持 `canonicalId = null`，由 outbox 或 verifyAndRepair 生成 create；或者像 initial 一样在服务端 plan 里真正 CREATE（放回原父目录或 `Recovered/<Device>`）。`settleAdoptedCreates` 只能在“该 canonical id 已出现在服务端 commit 中”时才结算。

代码依据：[reconcile/service.go#L568](server/internal/reconcile/service.go#L568)、[#L601](server/internal/reconcile/service.go#L601)；[desired.go#L256](server/internal/reconcile/desired.go#L256)；[initialReconcile.ts#L652](extension/src/core/sync/initialReconcile.ts#L652)；[recovery_test.go#L113](server/internal/httpapi/recovery_test.go#L113)。

#### R31 · P1 · 首次同步的歧义问题无法收敛，初始化卡在 waiting_user

1. 空选择（未作答）在 `applyDecisions` 里被保留为 Ambiguous，重新规划后 issue 依旧存在。docs/08 §11 和扩展界面都承诺“未作答 = 按安全默认（复制一份）”，但这个结果永远落不了地：客户端遇到 waiting_user 就返回，从不 commit。
2. `computeAndStorePlan` 调 `ReplaceIssues`，删除全部 issue 行（包括已答的），只为未解决项插入新 id 的行。下一次 `Decide` 的 `known` 只能从现存行重建，前一轮的答案丢失，已解决的歧义会重新出现。
3. `ResolveIssue` 在校验之前就写库。非法选择会被持久化，此后每次 Decide 都带着它返回 DECISION_INVALID。

场景：服务端 Work 目录下有两条相同 URL 的书签，浏览器有一条。用户不想选，直接提交，issue 原样返回，初始化永远完不成。有 3 个问题时先答 1 个、再答 2 个，第一个又会回来。

修复：把 `""` 和显式的 `"duplicate"` 都当作已决定，按 SourceOnly 处理。决定持久化在 session 上（或复用 issue 行，不要删），按 source_ref 稳定标识，重新规划时合并。校验通过后再写 `selected_choice`。

代码依据：[desired.go#L91](server/internal/reconcile/desired.go#L91)；[reconcile/service.go#L474](server/internal/reconcile/service.go#L474)；[store/sqlite/reconcile.go#L326](server/internal/store/sqlite/reconcile.go#L326)、[#L391](server/internal/store/sqlite/reconcile.go#L391)；[initialReconcile.ts#L170](extension/src/core/sync/initialReconcile.ts#L170)。

#### R32 · P1 · 对账进行中，用户对尚未映射节点的编辑不被捕获；其中删除会让初始化永久卡死

初始同步从提交快照到应用 steps 之间，整棵树都没有 mirror（只有 root）。若卡在 waiting_user，这个窗口可能持续几天。期间的删除、改名、子目录内新建，都被 EventProcessor 视为“无 mirror”而忽略，也不记 dirty。客户端无法重新提交快照（只有 collecting 阶段接受）。

- **删除**：服务端已按旧快照导入该节点；`applyAssignIdentity` 发现节点不存在只记一条 warn；`verifyAppliedSteps` 报“ended with no mapping”并抛错。服务端已 commit 且按 doc 06 §15 不回滚，于是每轮重试都失败，binding 永远卡在 initializing，只能解绑重来。
- **改名**：`applyAssignIdentity` 把浏览器**当前**标题写进 mirror，canonical 保留的是快照时的旧标题。浏览器与 mirror 一致，verify 查不出来，这次改名永远不会上传。

修复：按 doc 06 §13 / doc 22 B.12，对账期间捕获的事件按 browserId 记入 dirty 集合，不能因“无 mirror”丢弃。apply 阶段目标已消失的步骤视为“用户后来删除”，转成一条针对该 canonical id 的 pending delete，而不是让 verify 失败。complete 之后对 dirty 集合读取当前浏览器状态，生成 update/move。

代码依据：[eventProcessor.ts#L147](extension/src/core/sync/eventProcessor.ts#L147)、[#L222](extension/src/core/sync/eventProcessor.ts#L222)、[#L447](extension/src/core/sync/eventProcessor.ts#L447)；[reconcileSteps.ts#L121](extension/src/core/sync/reconcileSteps.ts#L121)、[#L416](extension/src/core/sync/reconcileSteps.ts#L416)；[initialReconcile.ts#L572](extension/src/core/sync/initialReconcile.ts#L572)。置信度：代码路径已确认，删除导致卡死的完整链路建议用集成测试复现。

#### R33 · P2 · 选定歧义目录后不再匹配其子项，目录内容被整体复制一份

歧义节点不递归 `matchChildren`；`applyDecisions` 只加 pair，也不重新匹配子树。用户把浏览器的 Work 判给服务端某个 Work 后，浏览器 Work 的子项全部成为 SourceOnly 新建，服务端 Work 原有子项又经 `keepSubtree` 保留。场景：服务端有两个 Work（旧导入遗留），浏览器 Work 里 200 条书签，选“合并到第一个 Work”后，服务端多出 200 条重复书签，与用户预期正好相反。

修复：fold decisions 之后，对每个新建立的 pair 调 `matchChildren(src, tgt)` 并重新计算 SourceOnly/TargetOnly。

代码依据：[match.go#L156](server/internal/reconcile/match.go#L156)；[desired.go#L113](server/internal/reconcile/desired.go#L113)。

#### R34 · P2 · Full Resync 的 complete 回包丢失时，客户端基线取错，中间的变更永久漏收

服务端对 resync 的 Complete 把 applied/received 写成 `TargetRevision`（快照点）。客户端 `finish()` 优先用 `env.binding.applied_revision`，但只有 complete 的回包才带 binding。若 complete 已在服务端成功、回包丢失，下一轮 GET 看到 completed 后走 `finish(env)`，`env.binding` 为空，回退到 `session.commitRevision`，即 commit 时的 head，可能比 TargetRevision 大。(TargetRevision, commitRevision] 区间的变更从此不会被拉取，verify 也看不出来。

修复：GET 对 completed session 也附带 binding；或客户端在 completed 分支先读 binding。resync/recovery 不要用 `commit_revision` 兜底。

代码依据：[reconcile/service.go#L1102](server/internal/reconcile/service.go#L1102)；[initialReconcile.ts#L607](extension/src/core/sync/initialReconcile.ts#L607)；[httpapi/reconcile.go#L417](server/internal/httpapi/reconcile.go#L417)。

#### R35 · P2 · Commit / Plan / Decide 不在写事务内复核 session，状态 UPDATE 没有谓词

1. 用户解绑时后台正在 initial commit：Commit 已过了事务外的 `loadActive`，随后 `AbandonOpen` 把 session 置为 failed；Commit 的事务里 epoch/revision 没变，照样把整棵浏览器树导入 canonical，`MarkSessionCommitted` 再把 failed 的 session 改成 committed。已撤销的 binding 写进了数据，违背 doc 22 B.21“在写事务内复核”。
2. waiting_user 时直接 commit 后 state 不变，之后 `Decide` 仍被允许，用旧快照和新 uuid 重算 plan/steps 并覆盖已 commit 的 steps 工件，客户端拿到的 canonical id 从未写进服务端（现有扩展不会主动触发）。
3. Plan 与 Commit 并发时，Plan 的更新可把已 commit 的 session 改回 server_ready/planned。

修复：Commit 在事务内 `LoadSession` 并校验 state、phase、`!server_committed`、binding 未撤销；所有阶段转移改为条件 UPDATE（`WHERE id=? AND phase=? AND server_committed=0`，检查 RowsAffected）；`MarkSessionCommitted` 同时把 state 设为 running；解绑时 `AbandonOpen` 与 `RevokeBinding` 放进同一事务。

代码依据：[reconcile/service.go#L820](server/internal/reconcile/service.go#L820)；[store/sqlite/reconcile.go#L115](server/internal/store/sqlite/reconcile.go#L115)；[httpapi/handlers.go#L273](server/internal/httpapi/handlers.go#L273)。

#### R36 · P2 · 对账工件与冻结快照从不清理，删除 Space 后书签内容仍残留

每次 Plan/Decide/重新冻结都插入新的全量工件（客户端快照、plan、steps 的完整 JSON，以及 `server_snapshot_nodes` 全树副本）。`expires_at` 只写不读，全仓没有任何 `DELETE FROM sync_artifacts|server_snapshots|reconciliations`；这几张表与 space 没有外键，删除 Space 或设备时也不清理。一万条书签的 Space 遇到 5 次 PLAN_STALE 就留下 6 份一万行的快照；用户删除 Space 或账户后，标题和 URL 仍以明文留在 SQLite 及其整实例备份里。

修复：session 完结或失败时删除其工件，重新冻结时删除上一份快照；maintenance 按 `expires_at` 清理；删除 Space/设备时级联清理（或加外键 ON DELETE CASCADE）。

代码依据：[reconcile/service.go#L264](server/internal/reconcile/service.go#L264)、[#L364](server/internal/reconcile/service.go#L364)；[000016_reconcile.sql](server/migrations/000016_reconcile.sql)；[store/sqlite/space.go#L153](server/internal/store/sqlite/space.go#L153)。

#### R37 · P2（疑似）· create step 在“浏览器已创建、映射未写入”之间崩溃，会重复创建并留下永不过期的预期

`expectedMutations.add`、`adapter.create`、写 mirror 分三步。worker 在 create resolve 之后、事务之前被杀（onCreated 回声随之丢失）时：续跑找不到 mirror 会再建一次，浏览器里出现两份，`verifyAppliedSteps` 不检查多出来的浏览器节点；第一次留下的 provisional 预期（`browserId = null`）永不过期，以后用户在同一目录新建同标题同 URL 的书签会被当作回声吞掉、不上传。

修复：续跑 create 前按 parent+title+url 在无 mirror 的子节点里采纳孤儿；expectedMutations 加 TTL 清理；complete 前的 verify 检查受管范围内无 mirror 的浏览器节点。需用 kill 注入测试确认实际频率。

代码依据：[reconcileSteps.ts#L149](extension/src/core/sync/reconcileSteps.ts#L149)；[eventProcessor.ts#L82](extension/src/core/sync/eventProcessor.ts#L82)。

### 3.4 导入导出 / 撤销 / 广场

#### R38 · P1 · Netscape HTML 导入不解码 HTML 实体，标题和 URL 被改写

`extractTag`/`extractHRef` 原样返回实体文本，全包没有 `html.UnescapeString`；导出时却会把 `&`、`"` 转义。Chrome/Firefox 导出的 HTML 同样带实体。

场景：导出含 `https://a.com/?x=1&y=2`、标题“Q&A”的 Space，再导入：URL 变成 `?x=1&amp;y=2`（链接错误），标题变成“Q&amp;A”；merge 按 URL 匹配不上已有书签，产生重复，预览把它们计为 create。

修复：对 title 与 href 先 `html.UnescapeString` 再做长度校验，最好改用 `golang.org/x/net/html` tokenizer；补导出 → 导入往返测试。

代码依据：[transfer/parse.go#L182](server/internal/transfer/parse.go#L182)、[#L205](server/internal/transfer/parse.go#L205)；[transfer/service.go#L148](server/internal/transfer/service.go#L148)。

#### R39 · P1 · 按根槽导出只包含根槽的直接子节点，文件夹内容全部丢失

`Export` 在 `rootKey != ""` 时只保留 `Parent.Type == Root` 的节点，所有后代都被丢掉；HTML 里文件夹成了空 `<H3>`，JSON 只剩顶层，接口照常 200。Web 的导出弹窗选中根槽时就走这条路径。用户以为拿到了备份，需要恢复时才发现数据不在里面。

修复：从根槽的直接子节点出发收集整棵子树；测试断言嵌套书签出现在导出结果里。

代码依据：[transfer/service.go#L106](server/internal/transfer/service.go#L106)；[ExportModal.tsx#L46](web/src/components/transfer/ExportModal.tsx#L46)。

#### R40 · P1 · 撤销 CREATE 类 ChangeSet 不检查后续修改，会删掉用户事后整理过的节点，且这次撤销不可再撤销

review 阶段对 CREATE 只检查“被创建的文件夹里有没有外来节点”，书签直接跳过；不比较节点的 title/url/structure revision 与 `cs.LastRevision`。执行阶段逐个 DeleteNode，不论节点现在在哪。撤销 batch 以 `undoable = false` 记录，没有 Before Image。

场景：导入 500 个书签，之后把其中 30 个拖进“常用”并改名。一周后撤销这次导入：review 判定 clean，“常用”里那 30 个一起被删，且无法撤回，只能靠备份。从广场 apply 后再撤销同理。doc 15 §6 要求“之后未产生需要保护的 dependent data”才可直接删除。

修复：对每个 Create 节点，若任一 revision 大于 `cs.LastRevision` 即进入 REVIEW_REQUIRED（或至少跳过这些节点）；撤销 batch 也记录 Before Image，使撤销本身可撤销。

代码依据：[changeset/service.go#L442](server/internal/changeset/service.go#L442)、[#L484](server/internal/changeset/service.go#L484)、[#L521](server/internal/changeset/service.go#L521)。

#### R41 · P2 · Pontis 自己导出的 HTML 无法正确导回

- 导出时空文件夹不写 `<DL>`；解析器遇到 `<H3>` 就入栈、只有 `</DL>` 才出栈，于是其后所有兄弟都挂到这个空文件夹下，整棵树层级错位。Main/{空 A, B{x}, y} 导回后 B 和 y 都成了 A 的子项。叠加 R39 时（所有文件夹都是空的）会变成一串层层嵌套的文件夹。
- 各根槽的顶层节点混在一起输出，`slots` 参数未使用；`roots[i].Position < roots[i].Position` 比较的是同一元素，排序是空操作。
- native JSON 导入忽略 `root_key` 与 `root_slots`，所有根槽内容并到同一个目标 parent 下。

修复：空文件夹也写 `<DL><p></DL><p>`（与 Chrome 一致）；解析器只在紧随的 `<DL>` 出现时才让文件夹入栈；按根槽输出顶层 `<H3>`；修正排序比较。

代码依据：[transfer/service.go#L131](server/internal/transfer/service.go#L131)、[#L146](server/internal/transfer/service.go#L146)、[#L163](server/internal/transfer/service.go#L163)；[transfer/parse.go#L111](server/internal/transfer/parse.go#L111)。

#### R42 · P2 · Replace 的预览与结果都不报告删除；广场子树 Replace 会清空目标里不相关的兄弟

广场 apply 的 Replace 先删除 `p.Parent` 下的**全部**子节点，再把发布树以 child 方式放进去；`ApplyResult` 没有 deleted 字段，预览只显示 `{created, updated, kept}`，activity 摘要只写“新增 N 项”。导入预览没有 strategy 参数，同样无法统计删除。doc 10 §10 / doc 11 §9 要求目标是整个 Space root 时先做安全备份并换 epoch，实现里只是普通的逐条 DeleteNode。

场景：用 Replace 把“开发”里的“Go 资源”刷新成发布的新版本，预览显示“新增 40，更新 0，保留 0”；确认后“开发”下另外 200 个与该发布无关的书签全部被删。

修复：结果与 dry-run 增加 deleted 计数；导入预览接收 strategy 和 parent；子树发布的 Replace 只替换对应的那个 child，或提供 contents 放置模式；目标为 Space root 时按文档走安全备份 + 新 epoch。

代码依据：[plaza/plaza.go#L631](server/internal/plaza/plaza.go#L631)、[#L702](server/internal/plaza/plaza.go#L702)、[#L732](server/internal/plaza/plaza.go#L732)；[transfer/service.go#L218](server/internal/transfer/service.go#L218)。

#### R43 · P2 · 对账写入的是另一套 ChangeSet 表：初始导入与恢复合并在 Activity 里看不到、不能撤销

reconcile 的 Commit 走 `executor.ApplyTxChangeSet`，写入 000017 的 `change_sets` / `change_set_undo_data`；Activity 与撤销 API 读的是 000015 的 `changesets`。`canonical/undo.go` 的 `ExecuteUndo`、`BuildUndoPlan` 只在测试里被调用，maintenance 也只清理 `changesets`。首次绑定时一次写入几千条书签的“初始导入浏览器书签”在 Activity 里没有记录，也没有撤销入口（doc 15 §8 把这类高层操作列为可整体撤销），`change_set_undo_data` 里的完整快照一直累积。

修复：reconcile 统一使用 `changeset.Service.BeginBatch(KindReconciliation)`，删除 canonical/changeset.go、undo.go 与 000017 这套表（或迁移合并）。

代码依据：[reconcile/service.go#L895](server/internal/reconcile/service.go#L895)；[store/sqlite/changeset_undo.go#L30](server/internal/store/sqlite/changeset_undo.go#L30)；[000015_changesets.sql](server/migrations/000015_changesets.sql)、[000017_changeset_undo.sql](server/migrations/000017_changeset_undo.sql)。

#### R44 · P2 · 恢复备份后，Activity 里新 epoch 的记录被旧 epoch 的记录挤出列表

`ListChangeSets` 按 `last_revision DESC` 排序，不看 epoch（注释写的“current epoch first”没有实现）。恢复后新 epoch 的 revision 从 1 开始，旧 epoch 的几千条全部排在前面，前 100 条全是不可撤销的旧记录，用户找不到刚才那次误删的“撤销”按钮。

修复：`ORDER BY (epoch = 当前 epoch) DESC, epoch DESC, last_revision DESC`，或按 `created_at DESC`。

代码依据：[store/sqlite/changeset.go#L184](server/internal/store/sqlite/changeset.go#L184)。

#### R45 · P2 · 发布源节点被跨空间搬运、删除或 Replace 后，就再也无法“更新快照”

`UpdateSnapshot` 只认 `pub.RootNodeID`，找不到就报 `ErrSourceNotFound`；PATCH 没有更换源节点的入口。跨空间搬运会换新 UUID，对自己 apply Replace 会删掉原节点，两者都让发布永久无法更新，只能删掉重建，而重建会让所有消费者的 import mapping 失效。doc 10 §7 规定 Publisher 可显式选择任意自己的节点更新某个 Publication。反过来，整空间发布在空间被清空后会静默发布一棵空树。

修复：PATCH snapshot 接受可选的 `space_id` / `root_node_id`（校验 owner）；源为空时拒绝或要求二次确认。

代码依据：[plaza/plaza.go#L305](server/internal/plaza/plaza.go#L305)；[httpapi/plaza.go#L178](server/internal/httpapi/plaza.go#L178)。

### 3.5 任务系统 / 调度 / 备份保留

#### R46 · P2 · `activity.gc` 不在 `jobs.type` 的 CHECK 约束里：浏览统计永远不清理，调度器每 30 秒报错

000012 重建 `jobs` 表时 CHECK 只列了 9 种类型，后来新增的 `activity.gc` 没有配套迁移。`EnqueueOccurrence` 的 `ON CONFLICT DO NOTHING` 不吸收 CHECK 违例；`Tick` 入队失败就 `continue`，不推进 `next_run_at`，也没有退避。新部署在上海时间 04:30 首次到期后，每个 30 秒 tick 都失败并打一条 Warn；服务端的浏览统计与批次审计永远不会按 180 天 / 30 天清理，违背 app/jobs.go 和扩展设置页对用户的保留承诺。管理员手动入队也会得到带 SQL 报错的 400。

修复：新迁移重建 `jobs` 表扩充 CHECK（更稳妥的是去掉 SQL 层枚举，由 Registry 校验）；`Tick` 遇到非瞬时失败时推迟或退避；加一条遍历 `jobs.Definitions`、逐类型经 SQLite 入队的集成测试。

代码依据：[000012_task_scheduler.sql#L9](server/migrations/000012_task_scheduler.sql#L9)；[jobs/jobs.go#L38](server/internal/jobs/jobs.go#L38)；[app/schedule.go#L23](server/internal/app/schedule.go#L23)；[schedule/schedule.go#L328](server/internal/schedule/schedule.go#L328)。

#### R47 · P2 · 任务租约不续期也没有 fencing：长任务 10 分钟后被第二个 worker 重复执行

`Claim` 固定给 10 分钟租约，`run()` 期间不续期（doc 13 §9 要求定期 renew）。其他 worker 空闲轮询时 `RecoverExpiredLeases` 把过期的 running 改回 queued 并再次 Claim；原 worker 的 handler 收不到任何信号（organizer 注释说的“reclaimed job stops the requests”不成立）。`Finish`、`ScheduleRetry`、`UpdateProgress` 都只按 `id` 更新，旧 worker 的终态会覆盖新 worker 的状态。

场景：大量超时站点的链接检查超过 10 分钟，第二个 worker 重新 Claim，结合 R48 此时所有条目仍是 pending，于是同一批 URL 再请求一遍；默认只有 2 个 worker，两个都被同一个 job 占住，备份和 GC 全部停摆。超过 10 分钟的 `backup.create` 会生成两份备份。

修复：在 `run()` 里随取消监视器定期续租（`WHERE id=? AND worker_id=? AND status='running'`），续租失败就 cancel `runCtx`；终态与进度写入加同样的 fencing 条件。

代码依据：[jobs/jobs.go#L302](server/internal/jobs/jobs.go#L302)、[#L323](server/internal/jobs/jobs.go#L323)；[store/sqlite/jobs.go#L124](server/internal/store/sqlite/jobs.go#L124)、[#L198](server/internal/store/sqlite/jobs.go#L198)。

#### R48 · P2 · 链接检查直到几乎全部检查完才开始写结果：崩溃后断点续查失效，进度一直是 0

分发循环在调用方 goroutine 里执行，每个条目先拿 `sem`（8 并发）；落库循环要等分发全部结束才开始。`results` 缓冲区是 `len(pending)`，worker 不阻塞，所有结果先堆在内存里。5000 条书签约 20 分钟的检查，前 19 分钟页面一直显示 0/5000；期间 kill -9、OOM 或容器替换，已检查结果全部丢失，重试从头扫描，与 doc 13 §16、doc 12 §2“崩溃后只补 pending”不符。

修复：落库循环先于分发在独立 goroutine 启动，边查边写；或按每 N 条 / 每 T 秒批量 `RecordResult` 并上报进度。

代码依据：[organizer/organizer.go#L208](server/internal/organizer/organizer.go#L208)、[#L247](server/internal/organizer/organizer.go#L247)。

#### R49 · P2 · 取消 queued / retry_wait 的任务不会阻止执行，副作用照常发生，状态却记为 cancelled

`RequestCancel` 只写 `cancel_requested_at`；`Claim` 不排除已请求取消的行，于是照样领取并执行 handler；取消监视器最早 200ms 后才检查，handler 返回后 `run()` 看到标志就记为 cancelled。用户取消一个排队中的自动备份，备份在 200ms 内写完，任务却显示“已取消”，还占用保留名额。retry_wait 的任务要等退避到期再跑一遍才生效。

修复：对 queued/retry_wait 用 CAS（`WHERE status IN ('queued','retry_wait')`）直接转 cancelled 并写 `finished_at`；`Claim` 加 `AND cancel_requested_at IS NULL`；只有 running 走协作式取消。

代码依据：[store/sqlite/jobs.go#L80](server/internal/store/sqlite/jobs.go#L80)、[#L152](server/internal/store/sqlite/jobs.go#L152)；[jobs/jobs.go#L410](server/internal/jobs/jobs.go#L410)。

#### R50 · P2 · 任务队列没有按类别隔离，也没有按空间去重：普通用户可让所有后台任务停摆

doc 13 §12 要求不让大量 LinkCheck 占满所有 worker，并按类别限制并发；实现只有一个全局 2-worker 池，FIFO，priority 恒为 0。`StartLinkCheck` 每次调用都新建 job，不检查同一空间是否已有 queued/running；用户可创建任意多个 schedule。普通用户连点 5 次“检查失效链接”或创建 20 个同一时刻的每日检查，就能让所有用户的自动备份、journal.gc、session.cleanup 排队几十分钟。

修复：`organizer.link_check` 独立并发上限（例如 1），系统维护类任务预留 worker；入队时对 `(type, space_id)` 的 queued/running 去重并返回现有 job_id；限制每用户 / 每空间的 schedule 数量。

代码依据：[app/jobs.go#L36](server/internal/app/jobs.go#L36)；[organizer/organizer.go#L152](server/internal/organizer/organizer.go#L152)；[schedule/schedule.go#L148](server/internal/schedule/schedule.go#L148)；[store/sqlite/jobs.go#L88](server/internal/store/sqlite/jobs.go#L88)。

## 4. 工程卫生（P3）

- `@pontis/protocol` 在生产代码中无人使用：扩展声明了依赖，却使用自己的 `core/protocol`；packages/api 中“扩展使用 @pontis/protocol”的注释不成立。要么让扩展真正 import，要么删除这个包，避免两份 wire 类型漂移。依据：[extension/package.json](extension/package.json)；[packages/api/src/types.ts#L235](packages/api/src/types.ts#L235)。
- 扩展活动页直接 `href={z.url}`，没有使用起始页的 `navigableUrl` 过滤。MV3 CSP 能挡住 `javascript:`，但与 doc 22 D.7 的约定不一致。依据：[ActivityTab.tsx#L469](extension/src/ui/ActivityTab.tsx#L469)。
- 出站策略的 `deniedByDefault` 缺 NAT64 `64:ff9b::/96`、`240.0.0.0/4`；`maxResponseKB = 4 << 10` 的实际单位是字节。依据：[outbound.go#L89](server/internal/organizer/outbound.go#L89)；[organizer.go#L578](server/internal/organizer/organizer.go#L578)。
- 恢复时 position 原样写入，不校验也不重排；手工编辑过、序号不连续的备份会破坏执行器“兄弟位置稠密”的假设。依据：[store/sqlite/backup.go#L184](server/internal/store/sqlite/backup.go#L184)。
- 注释中大量“以前是……”式的历史叙述，时间久了会与代码脱节，适合移到 ADR 或提交说明；`verifyReplica.ts` 文件头部留有删除后的空行。

第二遍深入阅读中发现的次要问题：

**认证与账户**
- 修改 email 撞上唯一索引时返回 500（任何错误都映射为 INTERNAL），且不做任何格式校验；传空串时存 `email=''`、`email_normalized=NULL`，与注册路径不一致。依据：[httpapi/account.go#L237](server/internal/httpapi/account.go#L237)。
- SSO 开通的账号（`password_hash` 为空）调用改密码接口得到 500，应返回 `PASSWORD_NOT_SET` 并在前端隐藏入口；`Login` 对空哈希账号立即失败、不跑 Argon2，构成区分“SSO 账号 / 密码账号”的计时侧信道。依据：[auth/password.go#L42](server/internal/auth/password.go#L42)。
- 两名管理员可以并发互相降级或禁用，导致 0 个 admin；`admin.go` 只禁止修改自己，应在同一事务里检查“剩余 active admin ≥ 1”。依据：[httpapi/admin.go#L82](server/internal/httpapi/admin.go#L82)。
- 扩展用密码配对时换到一条完整权限的 web session，只用来注册设备，之后从不 logout；login 响应 body 还回传 session token，削弱了 HttpOnly 的意义。依据：[extension/src/core/pairing/pairing.ts#L57](extension/src/core/pairing/pairing.ts#L57)；[httpapi/server.go#L575](server/internal/httpapi/server.go#L575)。
- 浏览统计上传时 host 的校验与入库规范化不一致（校验去尾点、入库不去），同一天重复 host 会撞主键返回 500，客户端整批重发形成毒丸。正常客户端已规范化，只有客户端 bug 或凭据被滥用时触发。依据：[activity/activity.go#L198](server/internal/activity/activity.go#L198)；[store/sqlite/activity.go#L59](server/internal/store/sqlite/activity.go#L59)。
- 全站没有 CSP 与 `frame-ancestors` 响应头。Lax cookie 使点击劫持目前不可利用，但 doc 22 D.7 完全依赖前端的 `safeHref`，建议补 `frame-ancestors 'none'` 与基础 `script-src 'self'` 作为纵深防御。
- `/auth/setup` 创建的首个管理员没有默认 Personal space，而 register、admin 建号与 OIDC 开通都会创建（doc 09 承诺“新用户自动创建默认 Space”）。若为有意，请在 doc 09 注明。

**对账引擎**
- 大树性能：冻结快照对**每个**节点（包括书签）调用一次 `tx.Children` 并逐行 INSERT，两万节点即在一个写事务里做四万次语句，叠加 R22 会阻塞整个实例；扩展端 `buildClientSnapshot` 的 `ref()` 每次 `Object.keys(refs).find`，是 O(N²)；`tree.index()` 的环检查为 O(N·depth) 且一次规划要执行 5–6 次。依据：[reconcile/service.go#L393](server/internal/reconcile/service.go#L393)；[initialReconcile.ts#L89](extension/src/core/sync/initialReconcile.ts#L89)；[reconcile/tree.go#L93](server/internal/reconcile/tree.go#L93)。

**导入导出 / 撤销 / 广场**
- ChangeSet 的 undo_data 与 activity 保留逻辑写在 `JournalGCSpace` 的 `floor <= 0` 提前返回之后，revision 不足 5 万的 Space（个人实例基本都是）永远不执行；删除 Space 时 journal、tombstones、changesets、change_sets、cross_space_transfers、link_check_*、publication_imports 都没有级联，书签全文永久残留。依据：[store/sqlite/maintenance.go#L70](server/internal/store/sqlite/maintenance.go#L70)；[store/sqlite/space.go#L150](server/internal/store/sqlite/space.go#L150)。
- 撤销的边角：MOVE 撤销会成环时执行器返回 `ErrTreeCycle`，接口回 500 而不是 REVIEW_REQUIRED；被撤销的 CREATE 节点已不存在时 `undoID` 为空，条目永远显示“可撤销”；撤销 DELETE 不按 `snap.Position` 回到原位，而是追加到末尾。依据：[changeset/service.go#L427](server/internal/changeset/service.go#L427)、[#L383](server/internal/changeset/service.go#L383)、[#L561](server/internal/changeset/service.go#L561)。
- 跨空间搬运的幂等检查在事务外、早于属主校验，并发重试可能得到 404 而不是重放结果（疑似）；设备端 `/sync/transfers` 不要求设备对源和目标 Space 都有 active binding，与 doc 08 §4 的设备最小权限不一致。依据：[spacetransfer/service.go#L137](server/internal/spacetransfer/service.go#L137)；[httpapi/transfers.go#L78](server/internal/httpapi/transfers.go#L78)。
- HTML 导入健壮性：深度只按 `<DL>` 计数，无 `<DL>` 的 H3 可无限入栈绕过 MaxDepth；`title[:255]` 按字节截断会切坏多字节字符；超长 URL 被静默截断成错误链接；`<H3></H3>` 得到空标题后整次导入 500（与 R14 同源）。导入 plan 的 Apply 不检查 TTL，stale 判断只比较 revision、不比较 epoch，且在事务外。依据：[transfer/parse.go#L111](server/internal/transfer/parse.go#L111)、[#L129](server/internal/transfer/parse.go#L129)、[#L147](server/internal/transfer/parse.go#L147)；[transfer/service.go#L329](server/internal/transfer/service.go#L329)。

**任务系统 / 调度 / 备份保留**
- 停机中断被当作失败：`backup.create` 把所有错误包成 `FatalError`，其他维护 handler 的 ctx 错误也不是 `Retryable`，滚动升级时当天的定时备份记为 failed 且不重试；`RecoverExpiredLeases` 不增加 attempt，会让导致进程崩溃的任务形成毒丸循环。依据：[jobs/jobs.go#L355](server/internal/jobs/jobs.go#L355)；[store/sqlite/jobs.go#L198](server/internal/store/sqlite/jobs.go#L198)。
- `backup.create` 在至少一次执行语义下不幂等：每次执行都用新 UUID 作 storage_key，崩溃或租约被抢后同一 occurrence 生成两份备份，挤占保留名额。doc 13 §10 要求 key 由 job 派生。依据：[backup/backup.go#L264](server/internal/backup/backup.go#L264)。
- `Tick` 与用户修改 / 暂停 / 删除计划之间是读-改-写竞态，`AdvanceNextRun` 无条件覆盖；窗口在毫秒级。依据：[schedule/schedule.go#L312](server/internal/schedule/schedule.go#L312)；[store/sqlite/schedule.go#L114](server/internal/store/sqlite/schedule.go#L114)。
- 被禁用账户的计划任务仍会继续执行（每日链接检查仍以服务器网络身份访问其书签 URL），与 R08 的修复思路不一致。依据：[store/sqlite/schedule.go#L95](server/internal/store/sqlite/schedule.go#L95)。
- `PurgeExpiredSafety` 不检查安全备份是否为该 Space 仅剩的一份，违反 doc 22 G.6；`ErrProtected` 定义了却无人使用，protected 备份可被直接删除。依据：[backup/backup.go#L444](server/internal/backup/backup.go#L444)、[#L54](server/internal/backup/backup.go#L54)。
- 管理员手动入队不校验空间，可对任意用户的 Space 入队 `organizer.link_check` 或 `backup.create`，归属记为管理员，用户看不到也取消不了，且没有审计。依据：[httpapi/jobs.go#L88](server/internal/httpapi/jobs.go#L88)。

## 5. 建议的推进顺序

1. **R25、R26（认证）**：账户劫持，改动集中在 OIDC 回调与账号关联，先于一切对外开放。R27、R28 随后一起修。
2. **R13、R14**：改动小、影响大，配合 adapter contract test 与含空标题的首次同步用例，优先独立提交。
3. **R29–R32（对账）**：Full Resync、Recovery 与歧义作答目前基本走不通；补一条“服务端真实 steps 驱动扩展 `applyReconcileSteps`”的端到端测试，再逐条修。R33–R37 随后。
4. **R15、R16、R30**：数据安全。先在 doc 22 补一条 ADR，明确“删除 vs 并发新建”和“浏览器独有节点在恢复中的去向”，再改两端。
5. **R38–R40（导入导出 / 撤销）**：导出是用户的备份手段，先修实体解码、根槽导出与撤销误删，补导出 → 导入往返测试。
6. **R17、R18、R19、R20**：消除“状态正常但实际不同步”的路径。
7. **R46–R50（任务系统）**：`activity.gc` 一条迁移即可修；租约续期、取消与队列隔离一起做。
8. **R21、R22、R23 及 R41–R45**：在开放公网注册之前完成。

验收继续沿用下一阶段计划的原则：每条修复说明覆盖了哪个可观察问题、经过了哪些真实边界（组件 / HTTP+SQLite / 构建产物 / 真实 Profile），Fake 与真实适配器执行同一契约。下列场景建议并入回归矩阵：

| 领域 | 场景 | 预期 |
|---|---|---|
| 认证 | 不带 state cookie 的 OIDC 回调；跨站 `text/plain` 登录表单 | 都被拒绝，不种下会话 |
| 认证 | 本地账号把 email 改成他人地址后，他人首次 SSO 登录 | 不关联到该本地账号 |
| 认证 | 两个并发 `/auth/setup` | 只有一个成功 |
| 排序 | 同父下移、移到末尾、移到紧邻下一项之后 | 真实 Chrome 与 Canonical 顺序一致 |
| 首次使用 | Profile 含空标题书签 | 初始化完成，标题保持为空或按 ADR 规范化 |
| 首次使用 | 存在歧义且用户不作答 / 分批作答 | 按安全默认完成初始化，已答项不丢失 |
| 首次使用 | 等待作答期间删除、改名浏览器节点 | 初始化完成，删除与改名在之后同步上去 |
| 恢复 | HISTORY_EXPIRED 后走 Full Resync | 用服务端真实 steps 完成，binding 回到 active |
| 恢复 | 带离线新建书签的 Mapping-lost Recovery | 新书签最终出现在服务端与其他设备 |
| 恢复 | Full Resync 的 complete 回包丢失后重试 | 基线为快照 revision，不漏收中间变更 |
| 删除 | 旧 base 删除文件夹 × 并发新建子项，两种到达顺序 | 结果一致，新书签可见 |
| 删除 | 本机未上传子项所在文件夹被远端删除 | 子项保留在浏览器中并有提示 |
| 结果 | REJECTED / CONFLICT / RECOVERED | 用户可见，可重新同步 |
| 挂载 | 部分模式拖入、拖出挂载目录 | 分别产生 create 子树与 delete |
| 调度 | worker 被频繁唤醒 24 小时 | sync 与 integrity alarm 按周期触发 |
| 并发 | 两设备同时收藏同一 URL | 每端各 2 个节点，且互不错配 |
| 导入导出 | 含 `&` 的 URL 与标题、空文件夹、嵌套目录，按根槽与整空间导出后再导入 | 往返后树与字段完全一致 |
| 撤销 | 导入后移动、改名其中部分书签，再撤销导入 | 进入人工确认，不删除被整理过的节点 |
| 任务 | 遍历全部 job 类型经 SQLite 入队；超过租期的长任务；取消排队中的任务 | 均可入队；不被重复执行；取消后不执行 |
| 资源 | 超大 body、超量 operations、并发登录 | 有界拒绝，不 OOM |
