# 第二轮复核整合附录

**整合日期：** 2026-10-19  
**对象：** Portkey Gateway 安全研究仓库  
**证据类型：** 本仓库本机复现 + 外部审查者独立复核  
**边界：** 所有本机请求均使用 mock upstream 和虚构凭据；独立复核结果在本文中明确标注，不冒充本仓库保存的原始动态日志。

## 结论

第二轮审查确认此前四项必修修正已经落实：同源十进制回环重定向不再被写成跨源 Authorization 保留；内存结果改为“无 body limit、随输入增长”，删除不可移植的绝对放大倍数和容量外推；`/public/auth` 的版本边界与 1.15.2 分开；十进制 IP 被解释为校验层与 URL/fetch 规范化语义差。

本轮还把 F-8、F-9、F-10 的状态改为更准确的表述：

| 编号 | 整合后的结论 | 证据边界 |
|---|---|---|
| F-8 | Azure/Vertex provider URL 组件注入型 SSRF | 本仓库已保存 Azure 本机 mock 结果；独立复核报告了 Azure 内网目标和 Vertex mock 结果，精确 tag 与修复回归仍需补齐 |
| F-9 | 慢速重试、资源和上游成本放大 | 本仓库已验证请求次数线性增加；独立复核报告无上限和客户端断开后继续重试；未测真实 provider 费用 |
| F-10 | `/v1/responses` 流式响应处理失败 | 本仓库已复现 `TypeError: immutable`；根因定位到 `responseService.updateHeaders` 修改不可变 Headers |

## F-8：provider URL 注入是独立的 SSRF 入口

本仓库在 `@portkey-ai/gateway@1.15.2` 上使用 TLS mock 验证了：`resourceName=127.0.0.1:18443#` 会使 Azure provider 请求到达本机 mock，而普通 `resourceName=127.0.0.1` 对照不会到达该 mock。原始结果保存在 `evidence/provider-url-injection-1792245900457.json`，脚本为 `reproduction/verify-provider-url-injection.mjs`。

第二轮独立复核进一步报告：

- `resourceName=172.26.3.45:18443#` 到达受控内网 mock；
- `vertexRegion=127.0.0.1:18443#` 到达受控 mock，并携带测试用 Bearer token；
- 这两条路径发生在常规 provider 路由上，不能归因于 deprecated `/v1/proxy/*` 缺少 `requestValidator`。

风险定性必须保持准确：测试中的 API key/token 是测试者自己提交的假值，因此证据证明的是“可向错误目标发起出站请求”，即 SSRF；它不证明攻击者从本次实验中窃取了真实 provider key。真实部署的影响还取决于 Gateway 运行身份、provider 配置、网络路由和出站凭据。

从架构上看，当前材料呈现出三个相关入口：

1. `custom_host` 的校验覆盖与 proxy 路由不一致（CVE-2026-82270 相关）；
2. Azure `resourceName` 直接参与 URL 拼接；
3. Vertex `vertexRegion`（以及待回归的 `vertexProjectId`）直接参与 URL 拼接。

这三者可以归纳为“SSRF 防护入口和校验覆盖不一致”的结构性问题，但不能合并成同一个 CVE，也不能用 provider URL 注入结果替代 CVE-2026-82270 的 proxy 复现。

## F-9：无界配置与断开后的慢速重试

本仓库已验证 mock 返回 `500` 时，默认请求为 1 次、`attempts=3` 为 4 次、`attempts=5` 为 6 次。第二轮独立复核补充了：retry schema 的 `attempts` 没有 `.max()`，源码中 `MAX_RETRIES = 5` 未接入执行路径；客户端以 `curl -m 3` 主动断开后，后台仍约每 4.4 秒重试，观察到 0 秒累计 2 次、5 秒累计 4 次、20 秒累计 5 次。

这支持将 F-9 从“候选”升级为已验证的慢速资源/上游成本放大行为，但要保留限定：`attempts=20` 在约 90 秒观察窗口内只完成约 8 次，不是突发高并发洪泛；本实验没有连接真实 provider，也没有产生真实费用。是否可由未授权客户端触发，仍取决于部署是否开放请求级 config、认证中间件和租户隔离。

## F-10：流式响应异常的根因

本仓库 `evidence/stream-responses-1792246934979.json` 显示：同一 mock 下 `stream=false` 返回 200，而 `stream=true` 返回 500；Gateway 日志出现 `TypeError: immutable`。第二轮复核建议把根因写明为 `responseService.updateHeaders` 尝试修改不可变 Headers，而不只引用异常文本。

当前证据支持可用性缺陷和潜在连接/重试影响，不支持远程代码执行、凭据泄露或跨租户读取。提前断流、慢速 SSE 和客户端重连仍应作为后续回归项。

## 版本和证据管理

独立复核中提到的“最新 main”结果不能自动回填为 1.15.2 结果。正式报告应同时记录精确 commit/tag、构建方式、启动参数、mock 日志和原始响应；只有在同一版本上重跑并保存附件后，才能把结果标为本仓库的“独立可重复证据”。

公开披露时，F-8 应使用“provider URL 注入型 SSRF”表述，F-9 应使用“慢速重试/成本放大”表述，F-10 应使用“流式响应 Headers 处理异常”表述；不要把虚构测试 key 的回显写成真实凭据泄露，也不要把 500 响应本身当作 SSRF 成功标准。

