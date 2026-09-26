<p align="center"><img src="docs/assets/co-memo-logo.png" width="112" alt="Co-memo" /></p>
<h1 align="center">Co-memo</h1>
<p align="center"><strong>你的记忆，在不同编程 Agent 之间共享。</strong></p>
<p align="center"><a href="README.md">English</a> | 简体中文</p>

Co-memo 为 **Pi、Claude Code、Codex 和 OpenCode 提供同一个本地记忆库**。在一个 Agent 中记住偏好或项目决策，换到另一个 Agent 后仍可读取。修改和删除也会同步。

- **默认共享：** Agent 是记忆的贡献者，不是各自独立的记忆所有者。
- **两种归属：** 项目事实、约定和决策属于 project；跨项目的个人偏好属于 personal（`user`）。Agent 根据内容选择归属，程序自动识别项目，不要求用户额外绑定。
- **本地同步，无需额外模型：** 使用 SQLite 和可编辑 Markdown。Co-memo 本身不要求账号、API Key、向量嵌入或模型服务；编程 Agent 仍使用自己的模型判断哪些信息值得记住。语义检索需主动启用。
- **冲突可检查：** 保留相互竞争的修改，不会悄悄用最后一次写入覆盖其他版本。
- **删除不会被旧副本撤销：** 删除标记会阻止过时副本重新恢复已遗忘的内容。

## Personal 与 project 如何区分

| 归属                 | 适合保存的内容                   | 示例                            |
| -------------------- | -------------------------------- | ------------------------------- |
| Personal（`user`）   | 跨项目适用的个人偏好和习惯       | “回答简洁一些，使用中文。”      |
| Project（`project`） | 某个工作区专属的事实、约定和决策 | “这个项目使用 pnpm 和 SQLite。” |

**运行位置用来识别项目，记忆内容用来决定归属。** 在仓库里讨论个人偏好，它仍然属于 personal。某条信息明显属于项目，但暂时无法确定项目时，不应把它自动转存为 personal。调用方省略 scope 时，仍使用配置中的 `defaultScope`，以兼容已有用法。

Co-memo 会根据已登记的工作区、Git 根目录或 worktree，以及常见项目清单文件自动识别项目。没有这些标记的工作区，可以由 Agent 根据当前任务通过 CLI `--project PATH` 或 MCP 参数 `projectPath` 提供路径，不需要用户单独执行绑定操作。多个工作区共用一个 MCP 服务时，如果当前工作区与服务启动目录不同，Agent 应在每次调用中提供实际路径。

在项目中读取时，结果包含 personal 和当前 project 的记忆；没有识别到项目时，仍可读取 personal，也可显式使用 `--scope user` 保存个人信息。使用同一存储的 Agent 共享这些个人记忆。自动识别项目只建立内部标识；**向 Agent 安装工具、skill 和 hooks 是另一项配置工作**。

## 安装

要求 **Node.js 24.12+**。自动配置 Agent 支持 macOS 和 Linux。

```sh
npm install -g @ahoh.tech/co-memo
cd /path/to/your/project
co-memo init --agents claude,codex --apply
```

也可以直接安装指定版本的官方 npm 压缩包，例如包索引尚未提供某个新版本时：

```sh
npm install -g https://registry.npmjs.org/@ahoh.tech/co-memo/-/co-memo-0.6.0.tgz
```

本文的自动项目识别、记忆控制台、文件位置和命名空间快捷指令反映当前源码。固定的 0.6.0 发布包早于这些功能；新版本发布前，请[从当前源码构建并安装](#从源码构建)。

npm 包已包含编译后的 JavaScript。普通用户无需 pnpm、TypeScript、Co-memo API Key 或本仓库源码。配置后重启 Agent。为 `init` 添加 `--hooks` 可启用生命周期自动注入；不添加时，由 Agent 主动调用记忆工具。

## 接入 Agent

在项目中运行 `co-memo init` 可进行引导配置。非交互用法：

```sh
co-memo init --agents claude,codex --apply
```

选择记忆进入 Agent 上下文的方式：

| 命令                                                 | 默认行为                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `co-memo init --agents claude,codex --apply`         | 仅工具模式：Agent 通过工具或 CLI 主动读取。                  |
| `co-memo init --agents claude,codex --hooks --apply` | 配置生命周期 hooks，自动注入上下文并同步。                   |
| `co-memo setup AGENT`                                | 配置单个 Agent，默认启用 hooks；添加 `--tools-only` 可禁用。 |

生成的指令要求 MCP Agent 在开始工作时调用 `memory_context`。Pi 在仅工具模式下使用 CLI。重新运行不带 `--hooks` 的 `init` 会选择仅工具模式，并移除 Co-memo 管理的 hooks。

从项目目录单独配置各 Agent，并启用 hooks：

```sh
co-memo setup pi
co-memo setup claude
co-memo setup codex
co-memo setup opencode
# 使用 OpenCode V2，而非 V1：
co-memo setup opencode --opencode-api v2
```

Pi 需要信任项目并执行 `/reload`；Claude Code 需要重启并批准项目 hooks；Codex 需要重启、信任项目并通过 `/hooks` 检查 hooks；OpenCode 需要重启以加载插件。配置会保留无关指令和设置，安装对话 skill，并为 Codex、Claude 和 OpenCode 添加项目级 MCP 工具。Pi 使用 CLI 和原生扩展。

启用且被宿主加载后，Pi 的项目扩展、Claude Code/Codex 的生命周期 hooks，以及 OpenCode 的项目插件会在提示或模型请求前注入当前上下文，在回合结束或工具执行后同步修改。新连接默认使用 OpenCode V1；`--opencode-api v2` 选择其不兼容的 V2 API。不指定该选项重新连接时，会保留已安装的 API 版本。Agent 未运行时，也可使用 `co-memo watch` 每两秒同步一次。

只安装工具、不使用 hooks：`co-memo setup codex --tools-only`，其他 Agent 同样支持。较底层的 `connect` 命令仅安装 hooks 集成。

## 可视化记忆管理

运行 `co-memo ui` 会启动服务并自动打开默认浏览器（默认 <http://127.0.0.1:4318>）。源码目录中可运行 `pnpm ui`，自动构建并打开。使用 `--no-open` 只启动服务；使用 `--port 0` 自动选择空闲端口。

英文控制台支持 System、Dark 和 Light 三种主题。选择会保存在当前浏览器中，并在页面渲染前应用；System 跟随操作系统配色。

页面支持浏览所有已登记项目及个人记忆、全文子串搜索、按项目和归档状态筛选，以及添加、编辑、归档、恢复和永久删除记忆。编辑和删除会校验版本，沿用 CLI 的同步与冲突保护；Archive 会从召回和 Agent 文件中隐藏记忆，长期保留内容及历史；Restore 可恢复。Delete 会永久清除记录、修订历史、相关冲突历史和派生缓存，只保留不含内容的 ID 标记，阻止旧副本复活。已有备份、导出副本和对话不受影响；文件清理失败会报告并在同步时重试。已有软删除记录显示为 Archived。浏览和刷新只读取中央存储，不触发 Agent 同步；保存后会尝试同步，并显示同步错误。

可用 `co-memo --home /path/to/data ui --port 4319` 指定数据目录与端口。服务只监听 `127.0.0.1`，按 Ctrl+C 停止。需要处理冲突时使用 `co-memo conflicts` 和 `co-memo resolve`。

也可以调用 Co-memo skill，说“打开 Co-memo 记忆管理页面”。展开记忆卡片的 **File locations** 可查看中央数据库路径、记录 ID，以及 Agent Markdown 副本的路径、行号和同步状态。命令行可用 `co-memo --project /path/to/project locations MEMORY_ID`。查看位置不会触发文件同步。

## 在 Agent 中直接调用

使用 `co-memo --project /path/to/project setup AGENT` 安装或更新接入，`AGENT` 可选 `claude`、`codex`、`opencode`、`pi`。不需要生命周期 hooks 时保留 `--tools-only`；使用 OpenCode V2 时保留 `--opencode-api v2`。安装后重新加载或重启宿主。

| Agent           | 打开控制台    | 查看功能列表    |
| --------------- | ------------- | --------------- |
| Claude Code     | `/co-memo:ui` | `/co-memo:help` |
| OpenCode        | `/co-memo:ui` | `/co-memo:help` |
| Pi              | `/co-memo:ui` | `/co-memo:help` |
| Codex CLI / app | `$co-memo ui` | `$co-memo help` |

这些指令输入在 Agent 的对话框中，不是在普通终端中。Codex CLI 也可以输入 `/skills`，选择 `co-memo` 后填写要求。Codex 使用原生 skill 入口，不注册 `/co-memo:ACTION` 别名。原有的 Claude/OpenCode `/co-memo ui` 和 Pi `/skill:co-memo ui` 仍可使用。

| `/co-memo:` 后的功能 | 用途                               |
| -------------------- | ---------------------------------- |
| `ui`                 | 打开记忆控制台                     |
| `recall QUERY`       | 搜索个人及当前项目记忆             |
| `remember TEXT`      | 按内容选择 scope 并保存记忆        |
| `edit ID CHANGE`     | 校验当前版本后修改记忆             |
| `archive ID`         | 归档并保留内容及历史               |
| `delete ID`          | 永久删除记忆及历史                 |
| `restore ID`         | 恢复归档记忆                       |
| `forget ID`          | archive 的兼容别名                 |
| `locations ID`       | 查看数据库和 Agent 文件路径        |
| `history ID`         | 查看修改历史                       |
| `settings [REQUEST]` | 查看设置，或执行明确要求的设置变更 |
| `status`             | 检查存储及 Agent 连接状态          |
| `sync`               | 同步已连接的 Agent 文件            |
| `conflicts`          | 列出未解决的冲突                   |
| `resolve ID CHOICE`  | 按用户明确选择解决冲突             |
| `help`               | 查看功能和调用示例                 |

Codex 使用 `$co-memo ACTION`，参数相同。例如：

```text
$co-memo recall 包管理工具
$co-memo remember 本项目使用 pnpm。
```

所有快捷入口加载同一份 Co-memo skill，保留 scope、版本和冲突检查。Claude 使用命令文件，OpenCode 使用命令包装，Pi 使用提示词模板。Pi 的项目模板要求项目受信任且已启用模板发现。`setup` 会安装这些入口，单独运行 `connect` 不会安装。路径和细节见[工具与设置](docs/tools-and-settings.md)。

测试覆盖生成配置、重复安装、同名文件保护及断开时清理。本机 Pi/OpenCode 已验证入口发现及参数展开／配置解析；这不代表每个宿主中的每条快捷指令都已完成真实模型执行。

## 验证记忆是否已加载

重启或重新加载 Agent 后，在项目中检查：

```sh
co-memo doctor claude --probe
# 或检查所有已登记项目：
co-memo projects --check
```

对于 MCP Agent，让它调用 `memory_context` 并检查实际工具结果；对于 Pi，让它执行生成指令中固定路径的 Co-memo CLI `context` 命令。没有相关记忆时，空结果也是正常情况。

`doctor --probe` 只验证配置的 MCP 服务能否响应，不证明正在运行的 Agent 已加载或使用它，因此诊断会报告 `hostMemoryLoaded: "unverified"`。Pi 不适用 MCP 探测。

保存后，其他 Agent 会在下一次成功的 hook 注入或工具/CLI 读取时取得记忆；已经加载的对话不会被改写。`.co-memo/<agent>.md` 是可编辑副本，不会仅因文件存在就自动进入模型上下文。

## 保存一次，多处读取

```sh
# 保存当前项目的决策。
co-memo add --scope project --content '这个项目使用 pnpm。'

# 保存跨项目、跨 Agent 的个人偏好。
co-memo add --scope user --content '请用中文简洁解释。'

co-memo list
co-memo status
```

也可以直接让 Agent 记住偏好或更新项目决策。生成的指令会引导它使用共享记忆流程，但这仍取决于宿主是否加载并遵循指令；配置不会强制模型保存每段对话。

## 控制保存与共享

配置后，可以说：“用 Co-memo 记住这个项目决策”或“只有我明确要求时才保存记忆”。完整说明见[对话工具与设置](docs/tools-and-settings.md)。

```sh
co-memo settings get
co-memo settings set --scope user --save-mode explicit
co-memo settings set --scope project --paused true
# 恢复：
co-memo settings set --scope project --paused false
```

设置会持久化，并由程序检查。仅显式保存模式会拒绝自动工具写入和 Markdown 导入式同步。保存意图由调用者声明，Co-memo 不会读取对话来核实。暂停会停止注入、同步和工具写入，但无法清除已经加载的上下文或已有本地文件。

## 可编辑的 Markdown

通过 `init`、`setup` 或 `connect` 配置的 Agent 会获得对应副本：

```text
project/
  .co-memo/
    pi.md
    claude.md
    codex.md
    opencode.md
```

每条记忆都有稳定 ID 和版本标记。修改块内文字即可更新；删除整个记忆块即可归档；在 `co-memo:new` 标记之间添加一条项目记忆即可新增。请保留文档标记及已有 ID、版本。

```sh
co-memo sync
```

Co-memo 会把修改合并到中央存储，并更新其他副本。它不会在 Agent 之间复制整个原生指令文件。生成的本地记忆和配置路径会加入 `.gitignore`。

## 导入已有记忆

```sh
co-memo import /absolute/path/MEMORY.md
co-memo import /absolute/path/preferences.md --scope user
co-memo import /absolute/path/memory-directory
```

导入是**显式、一次性的操作**。每个 Markdown 文件成为一条记忆，保留文字和来源路径。目录导入只处理其直接包含的 `.md` 文件，不会改写或持续监视原文件。重复导入完全相同的内容会复用原记忆；已归档的相同内容仍保持归档状态。

Co-memo 不会猜测原生自动记忆或第三方 Pi 记忆插件的数据位置。导入后，通过 Co-memo 管理的文件或 CLI 更新共享记忆；当前不支持任意原生记忆目录的自动同步。

## 修改、遗忘与解决冲突

```sh
co-memo show MEMORY_ID
co-memo edit MEMORY_ID --version 1 --content '使用 pnpm，并锁定依赖文件。'
co-memo archive MEMORY_ID --version 2
co-memo unarchive MEMORY_ID --version 3
co-memo delete MEMORY_ID --version 4
co-memo history MEMORY_ID

co-memo conflicts
co-memo resolve CONFLICT_ID --take current
# 或使用冲突输出中的 replicaId：
co-memo resolve CONFLICT_ID --take REPLICA_ID
# 或提供手动合并后的内容：
co-memo resolve CONFLICT_ID --content '合并后的决策'
```

冲突会冻结受影响的项目副本；解决前，冲突记忆不会进入注入上下文，所有竞争版本都会保留。删除整个副本文件**不代表删除全部记忆**。可用 `co-memo repair AGENT` 重建缺失文件，支持 pi、claude、codex 和 opencode。

## 安装维护

检查项目和管理集成：

```sh
co-memo projects --check
co-memo disconnect claude          # 仅预览
co-memo disconnect claude --apply  # 归档本地文件并移除受管理的集成
```

断开连接会保留中央记忆和其他 Agent 的配置。先关闭目标 Agent，完成后再重启；无法远程移除已加载的上下文。

备份整个中央存储，或恢复到新的数据目录：

```sh
co-memo backup /path/to/new-backup
co-memo backup-check /path/to/new-backup
co-memo restore /path/to/new-backup --to /path/to/new-data          # 预览
co-memo restore /path/to/new-backup --to /path/to/new-data --apply
```

恢复不会覆盖已有目标目录，并会解除旧副本登记。备份不包含未同步的 Markdown 修改或宿主配置。切换到恢复后的存储前，请阅读[备份与恢复](docs/backup-and-restore.md)。

**0.6 版本使用 SQLite schema 4**，支持关联 worktree 根目录和同一 Agent 的多个副本。升级保留已有记忆、历史和副本状态。旧客户端会拒绝新 schema，应一起升级连接到同一存储的安装，并重新配置，保留原有 hook 模式和自定义 `--home`。升级 Node 或移动安装目录后的固定路径修复，见[安装维护说明](docs/releasing.md)。

## 存储与边界

默认中央存储为 `~/.local/share/co-memo/shared-memory-v1.sqlite`，也支持 `XDG_DATA_HOME`。通过 `CO_MEMO_HOME` 或全局 `--home` 指定其他位置。全局选项必须放在子命令之前：

```sh
co-memo --home /path/to/data --project /path/to/project connect pi
```

- 项目由规范化目录标识。子目录复用其项目身份；独立克隆和 worktree 默认隔离。同一 Git 仓库的 worktree 可以[显式关联](docs/onboarding-and-worktrees.md)，共享全部项目记忆、设置和冲突。不同克隆不会自动合并，也没有独立的 branch/task scope。
- 同一 scope 内的记忆可由接入的 Agent 共享。这是单用户本地工具，不构成多用户安全边界。
- 不包含云同步、对话挖掘或原生记忆路径发现。可选[语义检索](docs/semantic-retrieval.md)结合缓存向量与本地全文检索。MCP 服务通过本地 stdio 运行。
- 每条记忆最多 32,000 字符；副本或导入文件最多 1 MiB。注入上下文约限于 16,000 字符，省略的记忆仍可通过 `list` 和 `show` 读取。
- 文件写入采用原子替换，并在写入前再次核对内容。外部编辑器不参与锁定，请避免在文件被替换时同时编辑。

更多内容：[Agent 配置](docs/agent-configuration.md)、[CLI 参考](docs/reference.md)、[同步架构](docs/architecture.md)、[开发说明](CONTRIBUTING.md)。这些详细文档目前为英文。

## 验证状态

自动化测试覆盖同步、按 scope 检索、冲突、删除标记、配置保留、备份恢复、断开连接、worktree 共享、并发，以及四种适配器的模拟生命周期事件。独立 npm 安装检查覆盖打包后的 CLI、MCP 启动和安装路径修复。

已通过的真实宿主验证包括：

- **Codex ↔ Claude Code：** 双向显式保存和新会话读取，核对实际工具调用及中央存储记录。
- **Claude Code hooks：** 在真实宿主中执行 SessionStart、UserPromptSubmit 和 Stop；禁用 MCP 与内置工具后，模型仍能回忆由 hooks 注入的随机值。
- **Claude 自动保存：** 七个隔离场景，包括隐含决策、偏好、纠正，以及推测、临时指令、仅显式模式和暂停时的不保存行为。

这些是受控环境中特定版本的验证，不代表所有宿主配置都能正常工作，也不等于通用提取准确率。模拟生命周期测试不能证明真实宿主已经加载集成。版本、证据和限制见[验证记录](docs/validation-record.md)。

## 诊断与评估

用 `co-memo doctor codex` 或 `co-memo doctor opencode --probe` 检查配置和可选的本地 MCP 传输，不会保存记忆。探测通过不代表宿主已批准或模型实际使用了工具。

在源码目录中：

- `pnpm eval` 运行检索基线；`pnpm eval:scale` 加入 1,000 条合成干扰记忆。
- `pnpm test:package` 检查独立 npm 安装和维护命令。
- `pnpm test:hosts` 检查已安装的 Codex/OpenCode CLI 就绪状态，不调用模型。
- `pnpm test:hooks` 和 `pnpm eval:autonomous` 使用已有认证和额度运行真实 Claude 模型，需主动执行，不属于常规 CI 检查。

大规模词法检索评估在前五条结果中找到了所有标注的相关记忆，没有 scope、删除或冲突泄漏，但也返回了一些较弱的部分匹配。三条仅语义相关的查询仍未命中；真实向量模型的质量尚未测量。向量检索默认关闭。指标与限制见[诊断与评估](docs/diagnostics-and-evaluation.md)。

提供方配置、显式索引、缓存有效性和模型评估见[可选语义检索](docs/semantic-retrieval.md)。

Agent 发现和引导配置可用 `co-memo init`。预览、worktree 关联规则及 `co-memo verify --round-trip` 见[引导配置、worktree 共享与真实宿主验证](docs/onboarding-and-worktrees.md)。

## 从源码构建

当前实现使用 **TypeScript + Node.js**，由 **pnpm** 管理，不会迁移旧版 Rust 数据库，也不保持旧版 CLI 兼容。

要求 **Node.js 24.12+** 和 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
npm install -g ./ahoh.tech-co-memo-0.6.0.tgz
```

pnpm 仅用于开发。Co-memo 使用 [MIT 许可证](LICENSE)。

归档沿用内部 `deleted` 字段，CLI `list --deleted` 可包含归档记录。`forget` / `memory_forget` 保留为归档的兼容入口；永久删除使用 `delete` / `memory_delete`。Skill 的 `restore` 动作调用 CLI `unarchive`，CLI `restore` 仍用于恢复数据库备份。新安装包含这些快捷指令；已有安装重新执行 setup 即可更新。
