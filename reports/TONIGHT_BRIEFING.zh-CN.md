# Portkey 安全研究今晚汇报提纲

## 一句话结论

在 `@portkey-ai/gateway@1.15.2` 的隔离环境中，我们确认了 `/v1/proxy/*` 的主机校验绕过和敏感头透传；进一步的本机实验与第二轮独立复核表明，Azure/Vertex provider URL 拼接还存在另一类 SSRF 入口，retry 配置存在慢速资源与上游成本放大风险，`/v1/responses` 流式处理存在可重复的 Headers 异常。

## 建议的 8–10 分钟讲法

### 1. 先讲研究边界（约 1 分钟）

“这次实验全部在本机隔离环境完成，Gateway 后面接的是自己写的 mock upstream。请求中使用的都是 `sk-local-*`、fake token 这类虚构值，没有连接真实 provider、云 metadata 或生产系统。因此报告结论是可重复的本地行为和代码路径风险，不把它包装成已经验证的生产入侵。”

### 2. 主结果：CVE-2026-82270 相关 proxy 绕过（约 2 分钟）

“普通 `/v1/chat/completions` 路由对不允许的 custom host 返回 `400 Invalid custom host`，mock 没有收到请求；相同请求改走 `/v1/proxy/v1/chat/completions` 后，mock 收到了出站请求。我们观察到 `Authorization`、`x-api-key`、`openai-organization` 等头被带到 mock，上游路径也可以被改成 `/admin/debug`。所以核心问题不是 Gateway 返回 500，而是请求是否已经离开 Gateway；mock 收到请求就是成功证据。”

“重定向部分需要谨慎：当前用例是十进制 loopback 被规范化后的同源跳转，能证明访问范围扩大和同源 Authorization 保留，不能据此断言跨源跳转也保留 Authorization。”

### 3. 结构性发现：provider URL 注入（约 2 分钟）

“F-8 与 proxy CVE 分开。Azure 的 `resourceName` 和 Vertex 的 `vertexRegion` 直接参与 URL 拼接。我们本机已经用 Azure TLS mock 观察到 `127.0.0.1:18443#` 使请求到达本机 mock；第二轮独立复核还报告了 Azure 内网地址和 Vertex loopback mock 的结果。”

“这里必须把风险说准确：实验里的 key/token 是测试者自己提交的假值，所以结论是错误目标出站请求，也就是 SSRF，不是本次实验窃取了真实 provider key。三个入口可以归纳为 SSRF 防护覆盖不一致，但不能合并成同一个 CVE。”

### 4. F-9 与 F-10（约 2 分钟）

“F-9 的本机结果是：mock 返回 500 时，默认请求 1 次，`attempts=3` 变成 4 次，`attempts=5` 变成 6 次。第二轮复核发现 `attempts` 没有 schema 上限，定义的 `MAX_RETRIES=5` 没有接入执行路径，客户端主动断开后后台仍会以约 4.4 秒间隔继续重试。它更像慢速资源和上游成本放大，不是突发洪泛；没有测真实 provider 费用。”

“F-10 的 `stream=false` 返回 200，`stream=true` 返回 500，日志为 `TypeError: immutable`。根因是 `responseService.updateHeaders` 尝试修改不可变 Headers。当前证据支持可用性缺陷和潜在连接影响，不支持远程代码执行或跨租户读取。”

### 5. 其他发现和收束（约 1–2 分钟）

“另外，F-2 只保留‘没有 body limit、内存随输入增长’这个结论，删除了不可移植的放大倍数和打满机器的外推；F-6 是独立的未认证 `/log/stream` 敏感日志暴露，1.15.2 的日志中可见测试 provider key、request URL 和提示词原文。F-6 不应与 SSRF 混写。”

“下一步是拿维护者修复版本或精确 commit 做前后回归，尤其补齐 F-8 的 Vertex 原始日志、允许目标正对照，以及 F-9 的断开重试时间线。当前报告可以作为阶段性结果和负责任披露材料。”

## 一页 PPT 可放的表

| 编号 | 结论 | 证据状态 | 当前边界 |
|---|---|---|---|
| F-1/CVE-2026-82270 | deprecated proxy 路由绕过 custom-host 校验并透传敏感头 | 本机 mock 已复现 | 未连接真实内部服务 |
| F-2 | 无 body limit，内存随请求体增长 | 本机剂量测量 | 不做终止性 OOM 或容量外推 |
| F-6 | 未认证 `/log/stream` 暴露敏感日志 | 本机已复现 | 限定 1.15.2/开发模式边界 |
| F-8 | Azure/Vertex provider URL 注入型 SSRF | Azure 本机；Vertex/内网为独立复核 | 精确 tag、原始附件和修复回归待补 |
| F-9 | 慢速 retry 资源/成本放大 | 本机线性放大；无上限和断开后重试为独立复核 | 未测真实 provider 费用 |
| F-10 | 流式响应 Headers 异常 | 本机 200/500 对照，根因已定位 | 仍需提前断流和修复版本回归 |

## 师兄可能追问

**问：你怎么证明不是 mock 或 harness 自己坏了？**  
答：CVE 主结果有普通路由负对照；provider URL 方向也有 `resourceName=127.0.0.1` 的未到达对照。下一版还会补允许目标正对照。判定主要看 mock 是否收到请求，不只看 Gateway 的 500。

**问：F-8 是不是凭据泄露？**  
答：本次不是。发送的是实验者自己放进去的 fake key/token；已确认的是可把请求发到错误目标。真实部署中的 provider 凭据影响需要结合运行配置另行评估。

**问：F-9 是否能直接称 DoS？**  
答：目前不应这样说。它是慢速资源和上游成本放大；请求间隔约 4.4 秒，观察到的请求量不是突发洪泛，未测真实费用，也要看客户端认证和租户边界。

**问：这些是不是一个漏洞？**  
答：不是。CVE-2026-82270 是 proxy 路由校验链缺失；F-8 是 provider URL 拼接入口；F-6 是日志鉴权/脱敏缺陷；F-9 和 F-10 是可用性方向。可以归纳为校验覆盖和边界控制不一致，但编号和修复建议要分开。

**问：现在最需要补什么？**  
答：同一精确版本上的 F-8 Vertex 原始日志与正对照、F-9 客户端断开时间线和上限测试，以及维护者修复版本的前后回归。

## 汇报时不要说的三句话

- “已经从 Portkey 窃取了真实 API key。”
- “只要返回 500 就证明 SSRF 成功。”
- “F-9 可以瞬间把服务打爆。”

对应的准确说法分别是：错误目标出站请求、以受控 mock 收到请求为主要证据、慢速资源/成本放大且影响受部署配置约束。

## 现场打开的材料

- [阶段性复现报告](PORTKEY_CVE-2026-82270_PHASE_REPORT.zh-CN.md)
- [第二轮复核整合附录](REVIEW_ROUND2_ADDENDUM.zh-CN.md)
- [后续验证附录](FOLLOWUP_VALIDATION_ADDENDUM.zh-CN.md)
- [GitHub 仓库](https://github.com/swordBone/portkey-security-research)

