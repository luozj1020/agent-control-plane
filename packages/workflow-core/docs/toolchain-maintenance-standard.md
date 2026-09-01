# Agent Workflow 工具链长期维护标准

状态：Normative v1.0

发布日期：2026-08-31

适用范围：产品核心、模式包、上下游 Harness 适配器、模型目录、配置激活、用量采集

本文规定产品如何长期支持 Codex、Claude Code、OpenCode、Cursor、Zcode 及未来
工具。文中出现的具体产品只作为适配器示例，不构成核心依赖或兼容性承诺。

## 1. 目标与非目标

本标准的目标是：

- 上游与下游工具可以独立选择、升级、替换和退役。
- 三种模式保持稳定语义，不随某个工具的功能变化而漂移。
- 供应商发布新模型时，用户通常无需等待产品发版即可配置。
- Harness 是否支持原生 subagent、会话恢复或用量采集必须来自可追溯证据。
- 配置激活可预览、可验证、可撤回、可回退，且不破坏用户已有配置。
- 适配器故障或信息过期时保守降级，不伪造兼容性或用量。

本产品不是模型代理、账号管理器或通用进程托管平台。除非用户另行明确授权，
配置激活不得自动登录、购买额度、启动 Harness、部署服务或修改供应商账号。

## 2. 规范用语

- **必须**：合并或发布前不可省略的要求。
- **应该**：默认需要满足；例外必须留下书面理由和风险说明。
- **可以**：可选实现，不影响标准合规性。
- **未知**：缺乏足够证据；不得等同于不支持，也不得等同于支持。

## 3. 稳定概念与可变实现

产品核心只拥有以下稳定概念：

| 概念 | 定义 |
|---|---|
| Upstream Harness | 用户直接启动并承载主会话、最终决策和模式指令的工具 |
| Downstream Harness | 接收委派任务并返回状态、产物和用量的执行工具 |
| Provider | 提供模型或兼容 API 的供应商、代理或本地服务 |
| Model | Provider 暴露的模型标识及其能力元数据 |
| Mode | Overnight、Balanced、Interactive 的协作语义 |
| Adapter | 将稳定核心协议映射到具体 Harness 或 Provider 的插件 |
| Profile | 一组可激活、可回退的上下游、模式、模型和角色选择 |

以下内容属于可变实现，禁止成为产品核心的隐式事实：

- Harness 的配置目录、配置格式、命令行参数和输出文本。
- 某个 Harness 是否支持原生 subagent、后台运行或会话恢复。
- 模型 ID、推理强度、上下文长度、价格和可用区域。
- Provider 与 Harness 的绑定关系。
- 角色文件格式以及内置角色名称。

核心层不得通过产品名分支实现业务行为，例如
`if harness == "codex"`。此类差异必须位于适配器或显式兼容性策略中。

## 4. 标准配置模型

持久配置必须区分工具、供应商、模型和模式：

```json
{
  "schemaVersion": 1,
  "upstream": {
    "harnessId": "opencode",
    "installationId": "local-default"
  },
  "mode": "balanced",
  "executionBackend": {
    "kind": "external-harness",
    "harnessId": "zcode",
    "installationId": "local-default"
  },
  "roles": [
    {
      "id": "reviewer",
      "model": {
        "providerId": "vendor-example",
        "modelId": "model-id-entered-by-user"
      }
    }
  ]
}
```

持久配置必须保存稳定 ID，不得只保存展示名称。未知字段和未知模型 ID 在读取、
编辑和重新保存时必须尽量无损保留。配置迁移必须幂等，并保留迁移前备份。

## 5. 模式语义

模式定义协作所有权，不定义具体品牌或命令。

### 5.1 Overnight

- 上游只负责初始规划/契约和最终审阅或有界修订。
- 下游负责持久执行、恢复、验证和完成收敛。
- 激活要求下游具备非交互执行、持久状态和可判定完成状态。
- 普通超时或进程重启不得被伪装成语义完成。

### 5.2 Balanced

- 上游保持活跃，每个经过调优的执行轮次结束后重新取得控制权。
- 时间策略包含上下文获取、活跃执行、基于进展的延长和硬截止；不得退化成单个
  固定等待窗口。
- 激活要求下游具备有界执行、状态/产物返回，以及在配置声明需要时的会话恢复。

### 5.3 Interactive

- 上游主 Agent 持续拥有意图、分解、写入协调、综合、验证和最终审阅。
- 执行后端必须是所选上游 Harness 已验证支持的原生 subagent 能力。
- 角色配置由上游 Harness 适配器生成；不得静默改用外部进程模拟原生 subagent。
- 所选 Harness 不支持或尚未验证原生 subagent 时，Interactive 必须不可激活，
  UI 必须显示原因和检测入口。

模式在一次运行开始后不得静默切换。需要切换时必须形成新的运行身份并让用户确认。

## 6. Harness 适配器标准

每个 Harness 适配器必须提供机器可读 Manifest，并明确自己可以作为上游、下游
或两者。推荐的逻辑接口如下：

```ts
interface HarnessAdapter {
  detect(): HarnessInstallation[]
  probe(installation: HarnessInstallation): CapabilityReport
  discoverModels?(installation: HarnessInstallation): ModelCatalogResult
  readConfiguration(installation: HarnessInstallation): ConfigurationSnapshot
  planActivation(profile: WorkflowProfile): ActivationPlan
  validateActivation(plan: ActivationPlan): ValidationResult
  applyActivation(plan: ActivationPlan): ActivationReceipt
  rollback(receipt: ActivationReceipt): RollbackReceipt

  dispatch?(request: DispatchRequest): RunHandle
  resume?(handle: RunHandle): RunHandle
  status?(handle: RunHandle): RunStatus
  interrupt?(handle: RunHandle): InterruptResult
  collectUsage?(handle: RunHandle): UsageRecord[]
}
```

适配器 Manifest 至少必须声明：

- 唯一 ID、展示名称、适配器版本和配置 Schema 版本。
- 支持的操作系统与 Harness 版本范围。
- `canBeUpstream`、`canBeDownstream`。
- Provider 策略：`fixed`、`configurable` 或 `unknown`。
- 能力声明及其探测方法。
- 读写路径范围、外部命令范围和所需权限。
- 配置迁移、备份和回退支持级别。
- 用量数据来源及完整性限制。

供应商开发且绑定供应商模型的工具仍属于 Harness；其 Manifest 可以声明固定
Provider。禁止因为工具由供应商开发，就把 Harness 与 Provider 合并成一个核心概念。

## 7. 能力探测与兼容性证据

能力状态统一为：

```text
supported | unsupported | unverified | degraded
```

- `supported`：当前安装环境已有通过的探测或受支持版本规则。
- `unsupported`：存在确定性不支持证据。
- `unverified`：没有足够证据，或证据已过期。
- `degraded`：基本功能可用，但有明确缺失或已知问题。

每条能力记录必须包含：

```json
{
  "capability": "nativeSubagents",
  "state": "supported",
  "source": "runtime-probe",
  "harnessVersion": "observed-version",
  "adapterVersion": "adapter-version",
  "observedAt": "RFC-3339 timestamp",
  "evidenceRef": "local receipt or rule id"
}
```

兼容性结论必须绑定完整元组：

```text
(adapter version, harness version, OS, architecture, authentication mode,
 provider route, relevant configuration schema)
```

禁止仅凭产品名称、模型名称、历史成功记录或文档宣传推断当前环境支持。Harness
升级、认证方式变化、Provider 路由变化或配置 Schema 变化后，相关证据必须失效并
重新探测。探测不得发送真实仓库内容；需要模型调用的探测必须明确展示可能产生的
费用，并由用户触发。

## 8. 模型目录与新模型处理

产品不得把内置模型数组当作完整事实来源。模型来源按以下优先级合并：

1. 当前 Harness/Provider 可机器读取的实时目录。
2. 用户已配置端点返回的目录。
3. 可独立更新且带版本的兼容性目录。
4. 随产品发布的离线后备目录。
5. 用户手动输入的模型 ID。

模型记录应该包含：

- `providerId`、`modelId`、展示名称和来源。
- 首次发现、最后发现、最后验证时间。
- Harness 可见性与账号可用性；两者不得混为一谈。
- 支持的推理级别、工具调用、上下文或多模态能力（仅在有证据时）。
- `active`、`preview`、`deprecated`、`retired` 或 `unknown` 生命周期状态。
- 价格与计费单位的来源、币种、生效时间和置信状态。

所有模型下拉框必须提供刷新与“手动输入模型 ID”。未知模型不得被自动删除，
也不得仅因不在内置目录中而阻止保存。激活前可以警告或执行可选探测。

模型退役必须先标记并提供替代建议；不得自动替换用户选择。供应商已经拒绝旧模型
时可以阻止新激活，但必须保留原配置、错误证据和手动迁移入口。

## 9. 配置激活、撤回和回退

激活必须使用事务式生命周期：

```text
discover -> plan -> preview -> backup -> write -> verify -> commit receipt
                                      \-> failure -> rollback
```

激活计划必须展示：

- 将创建、修改和删除的精确文件。
- 修改前后摘要及生成来源。
- 所需权限、冲突和不可逆操作。
- 当前 Profile、适配器和配置 Schema 版本。

产品必须保留字节级备份或等价的可验证恢复材料，并为每次成功激活生成收据。
回退只能恢复该收据拥有的修改；不得覆盖激活后发生的外部修改。检测到外部修改时，
回退必须停止并提供三方差异，不得强制覆盖。

删除角色或适配器属于可撤回编辑：提交激活前支持撤销/重做；提交后通过新的激活
事务或历史收据回退。任何时候都不得直接覆盖用户未被产品管理的配置段。

## 10. 用量与调用记录

用量记录必须区分：

- 上游与下游。
- Harness、Provider、模型和角色。
- 调用数、输入 Token、输出 Token、缓存 Token、估算费用。
- `observed`、`provider-reported`、`derived`、`estimated` 和 `unavailable` 来源。

缺失数据必须为 `null`/`unavailable`，不得显示为零。估算值不得与供应商账单混合，
并必须保存价格版本和估算时间。上游与下游可以在同一页面比较，但原始记录必须拥有
独立维度，图表筛选不得改变底层归因。

默认不得保存提示词正文、回复正文、密钥或完整环境变量。诊断需要正文时必须让用户
明确开启，并显示保存位置和清理方式。

## 11. 适配器生命周期与兼容策略

适配器使用以下生命周期：

```text
experimental -> preview -> stable -> deprecated -> removed
```

- `experimental`：允许不完整能力，但 UI 必须持续显示实验状态。
- `preview`：通过核心契约测试和至少一个受支持版本的真实探测。
- `stable`：具备声明范围内的激活回退、错误分类和兼容性测试。
- `deprecated`：停止新增功能，但继续提供迁移和只读识别。
- `removed`：仅在已完成迁移窗口后移除执行代码，历史记录仍可读取。

除安全问题或上游已不可用外，稳定适配器的破坏性移除应该至少提前两个次版本或
90 天（取较长者）公告。安全例外必须记录原因、影响和恢复方式。

适配器版本独立于产品核心版本。新模型目录和兼容性规则应该可以独立更新；适配器
代码更新必须经过签名或可信来源校验，不能把远程目录数据当作可执行代码。

## 12. 测试与发布门禁

每个适配器至少必须具有：

- Manifest 和 Schema 校验测试。
- 安装发现与多版本选择测试。
- 能力探测的成功、失败、未知和过期测试。
- 配置读取、生成和黄金文件测试。
- 重复激活幂等测试。
- 部分写入失败后的自动回退测试。
- 外部修改后的安全回退拒绝测试。
- 未知模型 ID 保留测试。
- 敏感字段清理测试。
- 声明下游能力时的 dispatch/status/resume/interrupt 契约测试。
- 声明用量能力时的完整、部分、缺失和格式漂移测试。

核心发布门禁必须覆盖至少以下组合：

```text
同一 Harness 上下游
不同 Harness 上下游
固定 Provider Harness
可配置 Provider Harness
新模型/未知模型
Harness 升级后证据失效
Interactive 原生 subagent 不支持/未验证
Balanced 延长窗口及硬截止
Overnight 持久恢复
激活后撤回与历史回退
```

真实 Harness 集成测试必须与确定性 Fake Adapter 测试分开。Fake Adapter 只能证明
核心协议，不得作为真实兼容性证据。

## 13. 发布节奏与维护触发器

以下事件必须触发兼容性评估：

- Harness 新主版本、配置 Schema 或命令输出发生变化。
- Provider 发布、重命名、弃用或退役模型。
- 认证、权限、沙箱或计费方式变化。
- 原生 subagent、会话恢复或用量接口发生变化。
- 用户报告配置损坏、错误归因或无法回退。

维护目标（非服务合同）为：

- 主流稳定模型发布后七日内完成目录确认；手动 ID 始终作为即时通道。
- 已知破坏性 Harness 更新在三个工作日内完成分级和兼容性公告。
- 数据损坏、密钥泄漏或不可回退风险立即停止受影响适配器的新激活。
- 每季度重新验证所有 `stable` 适配器的声明版本范围和回退路径。

若无法按目标完成，状态必须改为 `unverified` 或 `degraded`，不能继续显示为完全支持。

## 14. 扩展与信任等级

适配器分为：

| 等级 | 含义 |
|---|---|
| Built-in | 随核心发布并通过全部发布门禁 |
| Verified | 独立发布，但由项目维护者验证签名和兼容性 |
| Community | 社区维护，权限与风险必须在安装前展示 |
| Local | 用户本地定义，不提供兼容性保证 |

自定义 CLI Harness 应使用声明式命令模板和明确的输入/输出 Schema。模板不得默认
启用 shell 展开，不得读取未声明的环境变量，也不得获得超出 Manifest 的文件权限。
社区或本地适配器不得扩大核心进程权限。

## 15. 文档与变更记录

每个适配器必须维护：

- 支持的 Harness 版本和操作系统矩阵。
- 能力矩阵及最后验证时间。
- 配置写入路径、备份位置和回退说明。
- Provider/模型发现方式和已知限制。
- 用量采集的来源与缺失字段。
- Breaking change、迁移步骤和退役日期。

UI 展示的兼容性矩阵应该从同一份机器可读 Manifest 和探测收据生成，禁止维护一份
与运行时脱节的人工表格。

## 16. 合规审查清单

新增或修改 Harness、Provider、模式或模型功能时，审查者必须确认：

- [ ] 核心没有新增具体工具或模型的硬编码分支。
- [ ] 上游、下游、Provider 和 Model 身份保持独立。
- [ ] 模式语义未被适配器差异改变。
- [ ] 所有能力声明都有版本绑定证据和过期策略。
- [ ] 未知与缺失没有被转换为支持或零用量。
- [ ] 手动模型 ID 可以保存且不会被目录刷新删除。
- [ ] 激活具备预览、备份、验证、撤回和安全回退。
- [ ] 用户已有配置和未管理字段得到保留。
- [ ] 密钥、提示正文和敏感环境信息未进入普通日志。
- [ ] 适配器通过对应生命周期等级的测试门禁。
- [ ] 兼容性和迁移文档已由机器事实同步更新。

任何一项不满足都必须阻止宣称 `stable`；允许进入 `experimental` 或 `preview` 时，
必须在 UI 和发布说明中明确缺口。

## 17. 初始迁移顺序

现有实现向本标准迁移时按以下顺序进行：

1. 建立稳定 Profile、Harness Manifest、Capability Report 和 Activation Receipt Schema。
2. 将现有 Codex 专用逻辑收敛为第一个 Harness 适配器，不改变现有用户配置。
3. 将固定模型列表替换为目录合并、缓存和手动 ID。
4. 使用能力门禁控制模式可用性，首先关闭未经验证的静默兼容路径。
5. 建立通用下游调度协议，再迁移现有 Claude Code 执行逻辑。
6. 按同一契约增加 OpenCode、Zcode、Cursor 或其他适配器。
7. 接入统一但可分维度筛选的调用数、Token 和费用记录。
8. 最后开放 Verified、Community 和 Local 适配器安装机制。

迁移期间允许旧配置只读兼容，但所有新写入必须使用带版本的 Schema 和事务式激活。

## 18. v1 扩展接口落点

第一阶段接口预留已经固定为：

| 边界 | 当前落点 |
|---|---|
| Python Adapter Protocol、注册表和兼容性判定 | `scripts/toolchain_interfaces.py` |
| Harness Manifest | `schemas/harness-manifest-v1.schema.json` |
| 安装级能力证据 | `schemas/capability-report-v1.schema.json` |
| 上下游和模式 Profile | `schemas/workflow-profile-v1.schema.json` |
| 动态/手动模型目录 | `schemas/model-catalog-v1.schema.json` |
| 激活与回退收据 | `schemas/activation-receipt-v1.schema.json` |
| 契约和 fail-closed 行为测试 | `tests/test_toolchain_interfaces.py` |

这些接口只建立扩展边界，不宣称任何具体 Harness 已经通过兼容性验证。现有
Codex/Claude 路径在对应适配器完成迁移并取得能力证据前继续按原入口运行；不得仅因
Manifest 已注册就将 Harness 显示为可激活。

## 19. 单仓维护与发布边界

工作流本体必须作为 Agent Control Plane 仓库内的
`packages/workflow-core` 维护和发布，不得重新引入同级仓库发现、环境变量指向的
外部事实源或运行时 Git 拉取。

- 模式、Task Card、审阅/唤醒语义和 Python 工具首先在 workflow-core 修改。
- 所有跨语言消费字段必须进入版本化 Workflow Contract，并绑定 Schema 哈希。
- Web Runner 只能消费内置 Contract 投影；重复常量必须有精确同步测试。
- 根级 `npm run build`、`npm run typecheck` 和 `npm test` 必须包含 workflow-core。
- 产品发布物必须包含 workflow-core 的 Contract、Schema、运行工具和安装资源。
- 原独立仓库只可作为迁移历史归档，不能成为构建、启动、测试或运行前提。

如果未来需要拆分独立发布，应从单仓产物生成只读镜像；不得让镜像反向成为产品的
运行时权威来源。
