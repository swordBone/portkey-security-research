# Portkey 后续安全测试方向

**适用版本：** `@portkey-ai/gateway@1.15.2` 及其后续修复版本回归

**测试边界：** 仅使用本机 Gateway、本机 mock upstream、虚构凭据和受控请求量；不连接真实 provider、云 metadata、外部攻击者服务器或真实 API Key。

本文档用于扩展现有 CVE-2026-82270 复现，并吸收第二轮独立复核结果。公开 issue、独立复核和本仓库本机实验仍需分开标注；每个方向都需要单独记录版本、配置、请求、上游收到的内容和 Gateway 日志。

## 优先级一：provider URL 组件注入

Portkey issue #1596 报告了 Azure OpenAI 的 `resourceName`、Vertex AI 的 `vertexRegion`，以及 Vertex 的 `vertexProjectId` 在构造 URL 前缺少严格校验。独立第二轮复核已经报告 Azure 内网目标和 Vertex loopback mock 均可达，因此该方向应写成 **provider URL 注入型 SSRF 发现**。测试所用 key 是攻击者提交的虚构值，不能写成真实 provider key 泄露；精确 tag、正对照和修复版本仍需回归。

本地验证设计：

1. 为 Gateway 准备一个本机 HTTPS mock upstream，并只接受测试证书；
2. 用 Azure 和 Vertex 的 provider-specific header 分别设置带结构字符的测试值；
3. 使用假的 `sk-local-*` 或 `test-key`，观察 mock 是否收到请求；
4. 对比合法值、被拒绝值和包含 `#`、`?`、`/`、`@` 的值；
5. 只记录“是否连接到错误主机、请求路径和是否带测试认证头”，不访问真实云服务。

判定标准：provider 字段应只能生成预期的固定域名和路径；若 mock 收到请求，且请求目标偏离 provider 预期域名，应记录为 F-8。CVE-2026-82270 涉及的 proxy 入口与 F-8 provider 入口共同说明：Gateway 的 SSRF 防护存在多个入口、校验覆盖不一致的问题，报告中应按“同一结构性根因的不同入口”归纳，但不要混淆漏洞编号。

来源：[Portkey issue #1596](https://github.com/Portkey-AI/gateway/issues/1596)。

## 优先级一：重试与 fallback 的请求放大

Gateway 文档公开支持自动重试和 fallback。安全关注点不是功能本身，而是攻击者能否通过请求级 config 把重试次数、失败条件或目标数量扩大，造成上游请求放大、成本放大或跨 provider 凭据混用。

本地验证设计：

- mock 第一个响应固定返回 `429` 或 `500`，记录每次请求的次数、间隔、请求体和认证头；
- 分别测试默认配置、较小的合法重试值、边界值和非法超大值；
- 设置两个 mock provider，观察 fallback 是否把第一个 provider 的认证头带到第二个 provider；
- 使用固定小请求和总请求上限，禁止无限等待或高并发。

判定标准：配置应有上限、超限应被拒绝；客户端断开后不应继续无界重试；不同 provider 之间不应复用错误的 Authorization、Cookie 或 provider-specific header。第二轮复核已报告 `attempts` 无 schema 上限、死代码 `MAX_RETRIES` 未接线，以及客户端断开后仍继续重试。当前应定性为慢速资源/成本放大，不能直接称为远程代码执行或突发洪泛。

## 优先级一：流式响应错误导致的连接或重试放大

Portkey issue #1550 报告 `/v1/responses` 在 `stream=true` 时可能因修改不可变 Headers 抛出 `TypeError: immutable`，并提到客户端可能发生重连或重试。该方向更接近可用性测试。

本地验证设计：

- mock upstream 返回最小合法 SSE、提前断开、空 chunk、错误事件和正常 `[DONE]`；
- 对 `/v1/responses` 比较 `stream=false` 和 `stream=true`；
- 记录 Gateway 是否返回错误、是否重复访问上游、是否留下未关闭连接；
- 每轮只建立少量连接，并设置超时和最大测试时长。

判定标准：单次客户端请求不应导致无界重试、连接泄漏或请求体重复发送。该方向应标记为可用性缺陷，除非额外证据证明影响认证或数据机密性。

来源：[Portkey issue #1550](https://github.com/Portkey-AI/gateway/issues/1550)。

## 优先级二：开发控制台和日志暴露

1.15.2 构建包含 `/public/`、`/public/logs` 和日志流相关路由。当前核验附录没有确认 `/public/auth` 或限流实现，因此应检查运行模式和配置差异，而不是直接声称存在未授权访问。

本地验证设计：

- 分别以默认、`NODE_ENV=production` 和显式 admin token 配置启动；
- 访问 UI、日志页面、日志流和认证状态端点；
- 先发送带虚构 Authorization 的请求，再检查日志响应是否出现完整 token、Cookie 或 provider key；
- 对认证失败进行少量边界测试，记录是否限速和是否泄露详细错误。

判定标准：未认证用户不应读取请求头、请求体、provider 配置或日志流；日志应默认脱敏。该方向可形成信息泄露或认证加固项，但需要明确运行模式。

## 优先级二：主机规范化矩阵与 DNS/IP 钉扎

现有 F-1 已验证十进制 loopback 表达。下一步可系统测试 IPv6、IPv4 缩写、十六进制、尾随点、大小写、IDN、用户名段、非默认端口和 DNS 解析后的地址变化。

本地验证设计：

- 所有名称只解析到本机 mock；
- 每个变体都与正常路由做对照；
- 测试一次解析到公网、随后解析到回环的受控变化，但不连接外部网络；
- 记录校验时解析结果与实际连接目标是否一致。

判定标准：校验和实际连接必须针对同一个规范化目标；字面量私网地址被拒绝并不代表 DNS 结果已经完成钉扎。

## 优先级二：路径、查询参数和编码边界

现有报告已经观察到 proxy path 可以影响上游路径。可进一步检查 URL 编码斜杠、`..`、重复斜杠、空路径、查询参数重复键、片段符号和绝对 URL 形式是否导致目标路径变化或校验绕过。

本地验证设计：只让 mock 返回收到的 method、path、query 和 headers；不把路径指向真实管理接口，不执行任何管理操作。

判定标准：Gateway 应明确限制代理路径的语义，不能因规范化差异把一个公开 API 路径变成内部管理路径。

## 优先级二：Realtime WebSocket 的认证和生命周期

Gateway 暴露 `/v1/realtime`。测试重点是认证链是否与普通 `/v1/*` 一致、客户端 Authorization 是否被错误透传、连接关闭和异常重连是否有上限。

本地验证设计：使用本机 WebSocket mock，测试无认证、错误认证、合法认证、立即关闭、慢速消息和异常帧；不连接真实模型服务。

判定标准：未授权连接应在握手阶段失败；关闭和重连应受限；敏感头只应发送给明确的目标 provider。

## 优先级二：文件、批处理和 multipart 资源限制

构建包含 `/v1/files`、`/v1/batches`、fine-tuning 和 multipart 音频路由。这些路径应检查 body limit、文件大小、字段数量、批处理条目数量、异常清理和超时。

本地验证设计：使用小剂量到中等剂量的受控输入，逐步增加大小；每轮重启 Gateway，设置 RSS 上限和连接超时；不执行终止性 OOM 测试，也不上传真实文件。

判定标准：超限应返回 4xx，临时文件和内存应及时释放，单个请求不应产生未受控的后台任务。

## 不建议执行的方向

- 不使用真实 provider API Key、云 metadata 地址或外部攻击者服务器；
- 不进行高并发、终止性 OOM、真实凭据窃取或生产环境扫描；
- 不把公开 issue 的描述直接写成已确认 CVE；
- 不用 Gateway 返回的 `500` 单独判断 SSRF 是否成功，应以本地 mock 是否收到请求作为主要证据。

## 推荐的新增编号

| 编号 | 方向 | 当前证据等级 |
|---|---|---|
| F-8 | Azure/Vertex provider URL 组件注入 | 本机 Azure 已验证；独立复核确认 Azure 内网目标与 Vertex，精确版本回归待补 |
| F-9 | Retry/fallback 请求与凭据隔离 | 本机线性放大已验证；独立复核确认无上限和断开后继续重试，部署边界待补 |
| F-10 | 流式响应异常导致连接/重试放大 | 本机复现 `TypeError: immutable`，根因定位到 `responseService.updateHeaders` |
| F-11 | 开发控制台和日志敏感信息暴露 | 当前版本和运行模式相关，待验证 |
| F-12 | DNS/IP 规范化与钉扎缺失的扩展矩阵 | F-5 的扩展验证 |
| F-13 | 路径、查询和编码边界 | F-1 的扩展验证 |
| F-14 | Realtime WebSocket 认证和生命周期 | 路由存在，待验证 |
| F-15 | 文件、批处理和 multipart 资源限制 | 路由存在，待验证 |

最终报告应把 F-8 至 F-15 标记为“候选方向”或“待验证”，直到获得可重复的本地证据。
