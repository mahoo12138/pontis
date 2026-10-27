# Mantine 7 → 8 → 9 升级评估（TreeSelect go/no-go）

> 版本：V1（2026-10 评估）
> 范围：`web/` 与 `extension/` 两个 Mantine 前端；server 无关。
> 方法：mantine.dev 官方文档与迁移指南、GitHub Releases changelog、npm registry 元数据，以及直接解包 `@mantine/core` 8.3.18 / 9.7.3 的 dist 文件核对类型与实现；仓库侧为本轮实测 grep。所有非显然结论附来源 URL；查不到一手来源的标 **未证实**。

---

## 0 结论先行

**分两步走，不为 TreeSelect 单独冲 9.x；TreeSelect 本身也覆盖不了我们的四个文件夹选择场景。**

1. **TreeSelect 只存在于 9.2.0+**：`@mantine/core` 8.x 末版 8.3.18 的 dist 文件清单里没有 TreeSelect（jsdelivr 文件清单核对，[9.2.0 Release](https://github.com/mantinedev/mantine/releases/tag/9.2.0) 首发该组件，2026-05-11）。
2. **9.x 的 peer 要求 React ≥ 19.2**：`@mantine/core@9.0.0` 起 peerDependencies 为 `react: ^19.2.0`（[npm registry](https://registry.npmjs.org/@mantine/core)），官方迁移指南原文："Mantine 9.x requires React 19.2 or later. Update React before migrating. If you cannot update React yet, continue using Mantine 8.x."（[8.x → 9.x 指南 · Prerequisites](https://mantine.dev/guides/8x-to-9x/)）。我们在 React 18.3——**升 9 = 先升 React 19**，这一条决定 9 不是"顺手"能到的。
3. **8.x 仍兼容 React 18**（peer `^18.x || ^19.x`，[8.0.0](https://github.com/mantinedev/mantine/releases/tag/8.0.0)），且 7→8 破坏面小、对本仓库实测命中少。7.x 已被 npm 标为 `legacy`（dist-tag 指向 7.17.8，2025-06-02 后无再发布），继续停在 7.17.8 只是推迟成本。
4. **即便到了 9.7.x，TreeSelect 也不能直接替换 `FolderPickerField`**：single/multiple 模式**只有叶子节点可选中**（官方文档原文 "Only leaf nodes can be selected"，[TreeSelect · Expand on click](https://mantine.dev/core/tree-select/)），而我们的书签文件夹父节点本身可承载书签、必须可选；closed 字段显示祖先路径**没有对应 prop**（9.7.3 `TreeSelectProps` 全量核对，无 value-label/path 定制项）；**不虚拟化**（类型文件 0 处 virtual，官方 500 节点示例是用 Combobox 原语 + `@tanstack/react-virtual` 手搓的，见 9.2.0 Release）。详见 §4。

**建议**：第一步 7.17.8 → 8.3.18（低风险，独立做，收益=脱离 legacy + 拿到 Menu submenu、滚动条/通知等行为修正）；第二步 React 18→19 单独立项；第三步 8→9 在 React 19 落地后做，届时重新评估是"换 TreeSelect"还是"借 `useVirtualizedCombobox` 模式改造自研树"。决策定稿归档到 `docs/22-decisions-and-invariants.md` §A（见文末）。

---

## 1 版本与前置条件事实

| 事实 | 数值 | 来源 |
|---|---|---|
| `@mantine/core` latest | **9.7.3**（2026-10-17 发布） | [npm registry dist-tags/time](https://registry.npmjs.org/@mantine/core) |
| 8.x 线末版 | 8.3.18（2026-03-17） | 同上 |
| 7.x 线状态 | `dist-tags.legacy = 7.17.8`，末次发布 2025-06-02，**7 线已冻结** | 同上 |
| TreeSelect 引入版本 | **9.2.0**（2026-05-11 发布）；8.3.18/9.0.0/9.1.0 的 dist 均无 TreeSelect 文件，9.2.0 起有 | [GitHub Release 9.2.0](https://github.com/mantinedev/mantine/releases/tag/9.2.0)；jsdelivr 文件清单（`data.jsdelivr.com/v1/packages/npm/@mantine/core@8.3.18 / 9.0.0 / 9.1.0 / 9.2.0 / 9.7.3`）；9.7.3 tarball `lib/components/TreeSelect/` |
| TreeSelect 文档页 "Added in version" | 文档页**没有显示** Added-in-version 行（页面全文核对）；版本依据以上述 changelog + dist 文件为准 | [mantine.dev/core/tree-select](https://mantine.dev/core/tree-select/) |
| React peer：7.17.8 / 8.x | `^18.x || ^19.x`（当前安装 7.17.8 的 package.json 实测一致） | [registry](https://registry.npmjs.org/@mantine/core)、[8.0.0](https://github.com/mantinedev/mantine/releases/tag/8.0.0) |
| React peer：9.x（core/hooks/form/notifications 全部） | `^19.2.0` | [registry 各包 9.7.3 元数据](https://registry.npmjs.org/@mantine/form/9.7.3)、[9.0.0 Release](https://github.com/mantinedev/mantine/releases/tag/9.0.0)、[8x-to-9x Prerequisites](https://mantine.dev/guides/8x-to-9x/) |
| TypeScript / Node 最低要求 | **未证实**：`@mantine/core` 7/8/9 的 package.json 均无 `engines` 字段；官方文档未声明最低 TS/Node 版本。本仓库 TS 5.7.3，9.7.3 类型基于现代 TS 特性（`type-fest ^5`），无已知冲突 | tarball 实测 + 文档查无 |

对本仓库的直接含义：React 18.3 + Mantine 8.x 是合法组合；React 18.3 + Mantine 9.x 会在安装期 peer 解析即失败（这本身是最强的"测试能捕获"）。

---

## 2 7 → 8：逐条对账（变更 / 命中 / 症状 / 可否被测试捕获）

先纠正一个前提：**样式引擎换代发生在 7.0，不是 8.0**。6.x → 7.x 迁移指南明确 "Migration to @mantine/emotion"（Emotion 移出核心，成为可选包）与 "Migration to CSS modules"（[6x-to-7x 指南](https://mantine.dev/guides/6x-to-7x/)）。我们 7.17.8 里 `styles={{ root: {...} }}`、`classNames`、`createTheme` 的 `components.*.styles` 用的已是 7 系 vanilla-extract 体系；`StylesApiProps` 接口在 8/9 的 dist 类型中原样存在（9.7.3 `lib/core/styles-api/styles-api.types.d.ts` 实测）。**7→8 没有样式 API 破坏**。

| # | 8.0 变更（原文位置：[7x-to-8x 指南](https://mantine.dev/guides/7x-to-8x/)、[8.0.0 Release](https://github.com/mantinedev/mantine/releases/tag/8.0.0)） | 命中我们哪几处 | 症状 | 测试能否捕获 |
|---|---|---|---|---|
| 2.1 | 全局样式拆分为 `styles/baseline.css` / `default-css-variables.css` / `global.css`；**`styles.css` 整包导入不需要改** | 两 app 共 6 处入口全是 `import '@mantine/core/styles.css'`（web/src/main.tsx + extension 5 个 entrypoints/main.tsx） | 无 | 不适用（零改动） |
| 2.2 | `Portal.reuseTargetNode` 默认开启（官方警示：可能造成 z-index 堆叠问题；可用主题关回） | 所有走 Portal 的浮层：Modal（web 31 处/ext 4 处）、Popover（ext FolderPickerField）、Menu `withinPortal`（web Sidebar.tsx 1 处）、notifications 容器 | 层叠异常：下拉盖住模态、模态盖住导航等 | **jsdom 不测 z-index；捕获=否**，靠 CDP 截图回归 |
| 2.3 | `Popover` 新增 `hideDetached`，**默认开启**：target 被隐藏/移除/滚出视口时 dropdown 跟随隐藏 | ext `FolderPickerField.tsx` 的 Popover（target 是只读 TextInput，位于可滚动表单内） | 表单滚动或重渲染瞬间 dropdown 自行关闭 | RTL 可写交互用例；现有 guard 测试不覆盖 |
| 2.4 | `Menu.Item` 移除 `data-hovered` 属性（改 `:hover/:focus`） | 实测 grep `data-hovered`/面向 Mantine 内部的 `[data-*]` 选择器：**0 处** | 无 | 不适用 |
| 2.5 | `Switch` 默认样式含 thumb indicator | 两 app 均用 Switch（theme defaultProps 各设 size:sm） | 视觉漂移 | 截图对比；jsdom 无样式断言 |
| 2.6 | 日期系：回调改字符串、DatesProvider 移除 timezone、DateTimePicker `timeInputProps`→`timePickerProps` | **两 app 均无 `@mantine/dates` 依赖**（package.json 实测） | 无 | 不适用 |
| 2.7 | CodeHighlight 改用 Shiki；Carousel 需 embla 8 | 未使用 CodeHighlight/Carousel（imports 实测） | 无 | 不适用 |
| 2.8 | Other changes：ScrollArea wrapper 去掉 `display:table` 并新增 `content` 选择器；SegmentedControl 默认高度对齐 Input；Image 不再默认 `flex:0`；ColorInput 默认取色图标更新；**Notification 默认间距增大**；Checkbox/Radio/Chip `wrapperProps` 类型收紧 | ScrollArea：ext 2 处（FolderPickerField 下拉、其它）+ web；SegmentedControl：web；ColorInput：ext StartPageSettings；notifications.show：web 49 处/18 文件、ext 1 处（ui/notify.ts） | 视觉漂移（通知间距、分段控件高度）；类型收紧只影响传了 wrapperProps 的调用（实测 0 处传） | 截图回归为主 |
| 2.9 | 主题类型增强：`spacing/radius/fontSizes/shadows` 等可 `declare module` 增强（新特性，非破坏） | 可选收益：给 pontis 尺度做编译期校验 | — | — |
| 2.10 | `createTheme` / `components.*.defaultProps` / `inputWrapperOrder` | **无破坏**：8.3.19 中 `useProps("InputWrapper", ...)` 接线与 7.17.8 相同（tarball 实测），theme 级 `components.InputWrapper.defaultProps.inputWrapperOrder` 在 8/9 仍生效，且 `inputWrapperOrder` 同时仍是组件 prop（`use-input-props.d.ts`） | 无 | guard 测试（layout-invariants.test.ts `WRAPPER_ORDER` 源码 grep）版本无关，继续有效 |
| 2.11 | 类名与 CSS 变量 | 7/8/9 三版 `MantineProvider` 默认 `withStaticClasses = true`、`classNamesPrefix = "mantine"`（三版 esm 实测），运行时 DOM 一直带 `.mantine-<Component>-<selector>` 静态类；`.mantine-Button-root`（ext pontisTheme.css L421/425/430/434）在 8/9 继续命中。`--mantine-color-*` 变量名 8.3.18 与 9.7.3 的 `default-css-variables-resolver.mjs` 均原样发射（filled/light/light-hover/light-color/outline/text 全套）；`data-mantine-color-scheme` 属性机制在 8/9 的 `mantine-html-props`/`ColorSchemeScript` 中保留 → **ext pontisTheme.css 的 58 个变量重映射在 8/9 不失效** | 无 | 见 §5 的"正向断言"建议 |

> 历史事故复核：上下文中"7.17 Modal 无 `.mantine-Modal-content`"本轮**未能复现**——7.17.8 的 `ModalBaseStylesNames` 类型含 `'content'`，`ModalContent.mjs` 调用 `ctx.getStyles("content")`，静态类默认开启。当时失败的真实原因 **未证实**（可能与测试环境 `unstyled`/Provider 配置有关）。教训保留：类名断言必须配"正向存在性"检查，否则 vacuous pass。

---

## 3 8 → 9：逐条对账

来源：[8x-to-9x 指南](https://mantine.dev/guides/8x-to-9x/)（21 条）+ [9.0.0 Release](https://github.com/mantinedev/mantine/releases/tag/9.0.0) + 9.7.3 tarball 实测。只列能碰到我们面的：

| # | 9.x 变更 | 命中 | 症状 | 测试捕获 |
|---|---|---|---|---|
| 3.1 | **React/ReactDOM peer ≥ 19.2**（core/hooks/form/notifications 全部，registry 实测） | 两个 app 的 React 18.3.1 | 安装期 peer 冲突，装不上 | **是（最硬）** |
| 3.2 | `Text`/`Anchor` 的 `color` prop 移除，改用 `c` | 实测含跨行检查：`<Text ... color=` / `<Anchor ... color=` **0 处**（全仓 `c=`） | 无 | — |
| 3.3 | **light 变体 CSS 变量从 rgba 透明色改为实色**；官方给出 `cssVariablesResolver={v8CssVariablesResolver}` 过渡 | ext pontisTheme.css 重映射 `--mantine-color-{accentBlue,healthyGreen,warningAmber,recoveryOrange,errorRed,coolGray}-{light/light-hover/light-color}` 等 58 变量中的 variant 类变量；web semantic-tokens 只引用调色板 shade（`-0/-1/-6`），不受 variant 语义影响 | light Badge/Button/Alert 暗底上的观感变化（透明度→不透明） | 截图对比（CDP）；jsdom 无 computed-style 断言 |
| 3.4 | `useForm` 第二个泛型含义改变（TransformedValues） | web 5 文件 10 处 `useForm()`/`useForm`，**均无显式泛型**（`useForm<` 实测 0） | 无 | — |
| 3.5 | `TypographyStylesProvider` 更名 `Typography`；Popover/Tooltip 移除 `positionDependencies`；Collapse `in`→`expanded`；Spoiler/Grid/useLocalStorage/useHeadroom 等改名或返回类型变化 | 全仓 grep：TypographyStylesProvider/Collapse/Spoiler/Grid/positionDependencies/keepMounted **均 0 命中** | 无 | — |
| 3.6 | hooks 类型批量改名 + `use-mouse`/`use-fullscreen`/`use-mutation-observer`/`useEffectEvent` 迁移；`useDisclosure` 等命名空间类型新增 | 我们用的 hooks 面：useDisclosure、useMantineColorScheme、useComputedColorScheme、useForm（form）——运行面未变，类型面以 tsc 为准 | 编译错 | **是（tsc）** |
| 3.7 | 默认 `defaultRadius` 从 sm 改 md | 两 theme 均显式 `defaultRadius: 'sm'`（pontis-theme.ts L197 / pontisTheme.ts L140）→ 行为保持 | 无 | — |
| 3.8 | 新增 `theme.fontWeights`，9 默认 medium=600（8 为 500） | Button 的 `styles.root.fontWeight: 500` 在 theme 中硬覆盖（两 app）；Table `th` 500 硬编码 → 我们的排印意图不受 medium 默认影响；其它吃 medium 的组件（Badge/标题强调）字重 +100 | 截图对比 |
| 3.9 | Notifications：hover 任一通知暂停全部计时（`pauseResetOnHover` 默认变化，可回 `="notification"`）；9.2 增加滑动关闭 | web notifications.show 49 处/18 文件；ext notify.ts 1 处 | 行为漂移（批量 toast 存活时长） | 现有测试不断言计时；手工/新增 RTL 用例 |
| 3.10 | Modal/Popover/Button/Input 的 StylesNames：7.17.8 与 9.7.3 实测一致（仅 `InputStylesNames` 增加 `bottomSection`）；静态类机制不变（`ComponentClasses`/`getStaticClassNames` 在 9 仍在，withStaticClasses 默认 true） | ext `.mantine-Button-root`、测试里的 `.mantine-Divider-root`（Divider 名并集 'root'\|'label' 两版一致） | 无 | 加正向断言后**是** |
| 3.11 | `theme.components` 新增 `.extend()` 级联（9.2 "Shared default props for all inputs"：Input/InputWrapper 的 defaultProps 会级联到所有输入类组件）；`MantineThemeComponent`（classNames/styles/vars/defaultProps）在 9.7.3 类型中原样存在 | 我们的 `components: { X: { defaultProps, styles } }` 平面对象写法仍被 9.7.3 类型接受；若改用 `.extend()`，InputWrapper 级联语义与我们"复合 wrapper 调用处传回原顺序"的两处例外（StartPageSettings L492/L549）相容，但属可选重构 | 无强制改动 |
| 3.12 | 其它与我们面相关的 9.0 特性：Combobox 虚拟化（`useVirtualizedCombobox`，9.7.3 dist 实测存在）、Select/SegmentedControl 等泛型 value、Menu submenu 增强、`@mantine/schedule` 新包 | 均为新能力，不是破坏；`useVirtualizedCombobox` 是 §4 结论里"真正可用"的收获 | — | — |

---

## 4 TreeSelect 能否满足四个文件夹场景

四个挂载面（本轮 2026-10-20 排查点名的四处，均为「从文件夹树里选一个文件夹」）：`web/src/components/explorer/MoveNodesModal.tsx:85`（手写缩进列表，raw `<button>`）、`web/src/components/transfer/ImportModal.tsx:252`、`web/src/components/plaza/ImportModal.tsx:154`、`web/src/components/plaza/PublishModal.tsx:133`（后三处是对全部文件夹的扁平可搜索 `Select`，label 只有标题，同名文件夹分不出来）。扩展侧另有 `FolderPickerField` + `FolderTreePicker`（`BindForm.tsx:56`、`StartPageSettings.tsx:410`、`SyncTab.tsx:268` 三处调用），本轮已判定不换，此处一并纳入能力对账。以下按「从树里选一个文件夹、closed 字段显示路径」逐项核对（依据 9.7.3 `TreeSelectProps`/`TreeNodeData` 类型全文与 [文档页](https://mantine.dev/core/tree-select/)）：

| 需求 | TreeSelect（9.7.3） | 依据 |
|---|---|---|
| 受控单值 | ✅ `value: string | null` + `onChange`，`mode="single"` | 类型 `TreeSelectValue<Mode>` |
| 父节点（文件夹本体）可选中 | ❌ **single/multiple 模式只有叶子可选**："parent clicks only expand… Only leaf nodes can be selected" | 文档 Expand on click 段原文；`checkbox` 模式父节点可勾但输出 `string[]` + 级联语义，pills 渲染，不是单值控件 |
| closed 字段显示祖先路径（"A / B / C"） | ❌ 无任何 value-label/path 定制 prop（props 全量核对无 `getValueLabel`/`renderValue`；input 只显示节点 `label`） | 9.7.3 TreeSelect.d.ts |
| 搜索 | ✅ `searchable` + 自定义 `filter`，命中节点**连同祖先**显示；`nothingFoundMessage` | 文档 Searchable 段 |
| 大列表虚拟化 | ❌ 组件无虚拟化 prop（类型文件 0 处 virtual；文档页无 virtualization 段）；数百节点 = 全量 DOM 进 `ScrollArea`（`maxDropdownHeight` 默认 220）。官方 ~500 节点示例是用 Combobox 原语 + `@tanstack/react-virtual` 手搓 | [9.2.0 Release](https://github.com/mantinedev/mantine/releases/tag/9.2.0) "Tree select Combobox examples"；[Combobox 文档虚拟化段](https://mantine.dev/core/combobox/) |
| 折叠节点渲染 | ✅ chevron 展开 + 连接线（`withLines` 默认 true，可关），`defaultExpandAll`/`defaultExpandedValues`/受控 `expandedValues` 齐全；我们靠 `revealId` 展开选中项祖先的用法可用受控展开复刻 | 类型 + 文档 Expand state 段 |
| 禁用节点 | ❌ `TreeNodeData` 只有 `label/value/nodeProps/children/hasChildren`，**无 per-node disabled**；整件 `disabled` 有。逐节点禁用只能 `renderNode` 自行包装（payload 无 select 回调，接管程度**未证实**） | 9.7.3 Tree.d.ts / TreeSelectOption.d.ts |
| Modal 内使用 | **未证实**：文档未提；`comboboxProps` 官方示例专门演示改 `withinPortal`/`zIndex`，说明浮层组合需要自己调；扩展 MV3 页面内 Modal+Portal 组合无官方 demo | [文档 Combobox props 段](https://mantine.dev/core/tree-select/) |

**结论**：TreeSelect 覆盖不了四个场景的三条硬需求（父节点可选、closed 显示路径、扁平搜索结果——我们现在 `FolderHitList` 是"命中行 + trail"的平铺，TreeSelect 是"保留层级的树内过滤"）。换用它的净收益接近零，还会引入 `renderNode` 级别的重定制。9.x 里真正值得借的是 **`useVirtualizedCombobox` 模式**（若将来树的规模需要虚拟化）。也就是说：**"为了 TreeSelect 升 9"这条理由不成立**；升级决策应回到"脱离 legacy 线 + 行为修正 + 为 React 19 铺路"本身。

---

## 5 本仓库 blast radius（实测计数）

grep 范围：`web/src`、`extension/src`（.ts/.tsx/.css），排除 node_modules 与 `chrome-mv3` 构建产物。"调用点"= 正则匹配次数，"文件"= 命中文件数。

| 模式 | web | extension |
|---|---|---|
| `styles={{` | **63 / 22** | 2 / 2（FolderPickerField、FolderTreePicker） |
| `classNames={{` | 0 | 0 |
| `createTheme` | 1 文件（theme/pontis-theme.ts） | 1 文件（theme/pontisTheme.ts） |
| theme `defaultProps`（含 components 块） | 16 / 1 | 10 / 1 |
| `withinPortal` | 1 / 1（Sidebar.tsx:205 Menu） | 0 |
| `<Portal` 直接使用 | 0 | 0 |
| `<Modal\b` | **31 / 18** | 4 / 2（options App、StartPageSettings） |
| `<Popover\b` | 0（仅 theme 里 Popover.defaultProps.shadow） | 3 / 1（FolderPickerField） |
| `<Menu\b` | **55 / 9** | 0 |
| `<Select\b` | 20 / 9 | 5 / 3 |
| `<MultiSelect\b` / `Combobox` | 0 | 0 |
| `notifications.show` | **49 / 18** | 1 / 1（ui/notify.ts） |
| `useForm` | 10 / 5 | 0 |
| `inputWrapperOrder`（theme+调用点） | 1（theme L141） | 3（theme L120 + StartPageSettings L492/L549 例外传回） |
| `@mantine/core/styles.css` 导入 | 1 | 5（5 个 entrypoint） |
| `var(--mantine-*)` 引用 | 51 / 12 文件 | 109 / 2 文件 |
| `.mantine-*` 硬编码类选择器 | **0** | **5 处 / 2 文件**（见下） |

**硬编码类名清单（类名变更会静默打破的全部位置）**：
- `extension/src/theme/pontisTheme.css` L421 / L425 / L430 / L434：`.mantine-Button-root`（press 反馈 transition 与 :active scale，含 reduced-motion 分支）。
- `extension/src/ui/DiagnosticsPanel.test.tsx` L55：`container.querySelector('.mantine-Divider-root')` 断言 `toBeNull` —— 这是"不应存在"断言，类名若改它照样 vacuous pass；`web/src/lib/component-invariants.test.ts` 与 `extension/src/ui/layout-invariants.test.ts` 均为源码 grep 守卫，与 Mantine 版本无关。

**CSS 变量面**：`extension/src/theme/pontisTheme.css` 在 `[data-mantine-color-scheme="dark"]` 块内重定义 **59 行 / 58 个 distinct** `--mantine-color-*`（gray-0..9、dark-0..9、body/text/placeholder/dimmed/error、以及 accentBlue/healthyGreen/warningAmber/recoveryOrange/errorRed/coolGray 的 filled/light/light-hover/light-color/outline/text 全套，`!important`）。经 8.3.18/9.7.3 dist 核对，变量名与 `data-mantine-color-scheme` 机制均存活（§2.11），9 的 light 语义变化是值不是名（§3.3）。

**组件回归面规模**（distinct `@mantine/*` 具名导入，实测脚本统计）：
- web：41 个具名 —— 33 个 UI 组件（ActionIcon/Alert/Anchor/Badge/Button/Center/Checkbox/CopyButton/FileButton/Group/List/Loader/Menu/Modal/Notifications/NumberInput/Paper/PasswordInput/Progress/Radio/ScrollArea/SegmentedControl/Select/Skeleton/Stack/Switch/Table/Tabs/Text/TextInput/Title/Tooltip/UnstyledButton）+ MantineProvider + notifications + 4 hooks + MantineColorsTuple。导入面 46 个文件。
- extension：33 个具名 —— 29 个 UI 组件（ActionIcon/Alert/Anchor/Badge/Box/Button/Code/ColorInput/Divider/Group/Input/List/Loader/Modal/Notifications/PasswordInput/Popover/Radio/ScrollArea/Select/Slider/Stack/Switch/Table/Tabs/Text/TextInput/Title/Tooltip）+ MantineProvider + notifications + useComputedColorScheme。导入面 29 个文件。

---

## 6 迁移工具（问题 4）

- **官方 codemod：没有。** `@mantine/codemod` 在 npm 404（registry 实测）；7x-to-8x、8x-to-9x 两份指南通篇未提 codemod。
- **迁移指南：逐条 before/after 代码对照，指令性很强，但全人肉。** [7.x → 8.x](https://mantine.dev/guides/7x-to-8x/)（11 节）、[8.x → 9.x](https://mantine.dev/guides/8x-to-9x/)（21 节 + Prerequisites + "Update all @mantine/* packages to version 9.7.3"）。
- 9.x 官方额外提供 **LLM 迁移文档**：`https://mantine.dev/llms/guides-8x-to-9x.md`（实测 200；指南 "Migrate with LLM agents" 节直接给链接），以及 9.0.0 Release 引入的 `@mantine/mcp-server` 包与官方 Claude Code/Codex skills（[9.0.0 Release](https://github.com/mantinedev/mantine/releases/tag/9.0.0)）。8→9 可用它们做机械化改写，7→8 靠指南清单即可。

---

## 7 工作量与风险分级

| 步骤 | 内容 | 量级 | 风险 | 主要残余风险点 |
|---|---|---|---|---|
| A. 7.17.8 → 8.3.18（两 app 同步） | 版本号；无 API 必改点（§2 命中全是行为/视觉项）；`tsc` 过一遍 | 小 | **低-中** | Portal z-index 堆叠（2.2）、Popover hideDetached（2.3）、Switch/通知/分段控件视觉（2.5/2.8） |
| B. React 18.3 → 19.2（两 app） | react/react-dom/@types；测试栈（vitest 2.1 + jsdom ^24 是我们为崩溃钉的旧组合，React 19 下多半要连 vitest/jsdom 一起动，`extension/src/testing/setup.ts` 的 matchMedia stub 保留与否要实测）；WXT 对 React 19 的兼容性 **未证实** | 中 | **中** | 与 Mantine 无关的 react-router 6.28 / TanStack Query 5 / RTL 16.2 均声明支持 React 19（未逐一核对到具体小版本，标 未证实） |
| C. 8 → 9.7.x | peer 自动放行后：先挂 `cssVariablesResolver={v8CssVariablesResolver}` 保 light 语义（§3.3），再逐组件决定去除；tsc 修 hooks 类型面（§3.6）；notifications 行为项（§3.9）；可选：`Input`/`InputWrapper.extend()` 级联整理两份主题 | 中 | **中-高** | 暗色面板 58 变量的逐项视觉确认；fontWeights medium 600 的排印漂移（§3.8） |
| D. 树选择改造（可选） | 用 9.x `useVirtualizedCombobox` + Combobox 原语重建 FolderPickerField（获得虚拟化），TreeSelect 直换 **不可行**（§4） | 中 | 中 | 行为对齐：reveal/祖先展开、trail 平铺搜索、路径 label 都是现自研件 |

不升的选项同样有成本：7.17.8 是 legacy 末版（不再有任何修复），两份手抄主题继续对着一份冻结的 API 漂移。

---

## 8 建议落地顺序与验证手法（沿用本仓库既有流程）

1. **先验证再动手**：补一组"正向"类名/变量存在性测试（如渲染后断言 `.mantine-Button-root`、`data-mantine-color-scheme` 实际出现在 DOM），消除 §5 的两处 vacuous 断言；这一步在 7.17.8 上做，作为升级前的基线。
2. **步骤 A（→8.3.18）**，分支上两 app 同时切，跑：`pnpm -r test`（vitest+jsdom24 现状）、`tsc --noEmit`。视觉回归：extension 用 Chrome for Testing + CDP 截图对比（options/onboarding/popup/start-page 四入口，重点：Switch、按钮 press 反馈、通知、Popover 在表单滚动时的关闭行为）；web 把 `web/dist` 塞进 Go 二进制起同源临时实例（注意既有的端口撞车/系统代理坑），重点：Menu 55 处、Modal 31 处的层叠与滚动。
3. **步骤 B（React 19）** 独立立项，与 Mantine 解耦；此步完成后 Mantine 9 的前置条件自动满足。
4. **步骤 C（→9.7.x）**：借 `/llms/guides-8x-to-9x.md` + 指南清单执行；第一阶段就挂 `v8CssVariablesResolver`，diff 稳定后再逐组件撤。CDP 截图基线换成升级前同数据截图。
5. **步骤 D** 在 C 稳定后评估；决策记录（升/不升/何时）落 `docs/22-decisions-and-invariants.md` §A 带日期子节，本文件只作评估过程存档。

## 附：未能证实清单

- "7.17 Modal 无 `.mantine-Modal-content`"的历史结论：本轮在 7.17.8 dist 中未能复现（union 含 `content`、静态类默认开启），原因未定位。
- Mantine 9 的最低 TypeScript / Node 版本：无 engines、文档无声明。
- TreeSelect 在 `Modal` 内（尤其扩展 MV3 页面）的可用性：无官方说明，需 spike。
- `renderNode` 能否完全接管节点的选中/禁用交互：类型 payload 无 select 回调，行为面未逐一试探。
- WXT 0.20 + React 19、vitest 2.1 + jsdom 24 + React 19 的组合：未验证。
- "四个 folder-picking surfaces"的第四处具体所指（推测为 web 侧 MoveNodes/Transfer 的目标选择）：未从文档中得到确认。

---

*决策落定后，将 durable 结论（而非本评估全文）写入 `docs/22-decisions-and-invariants.md` §A 的带日期子节。*
