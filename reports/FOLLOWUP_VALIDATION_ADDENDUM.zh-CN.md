# 后续攻击方向验证附录

**验证日期：** 2026-10-17  
**验证对象：** `@portkey-ai/gateway@1.15.2`  
**环境：** 本机 Gateway + 本机 mock upstream  
**凭据：** 仅使用 `sk-local-*` 虚构测试值

本附录记录对后续候选方向的第一次动态验证。结果只适用于当前本地构建和测试配置，不代表真实 provider、云 metadata 或生产网络已经受到影响。

## F-8：Azure provider URL 组件注入候选

公开 issue #1596 描述 Azure `resourceName` 在拼接 URL 前缺少严格验证。为避免访问外部服务，本次启动了本机 HTTPS mock，并将 TLS 校验仅在测试进程内关闭。

测试对照：

- 对照值：`resourceName=127.0.0.1`
- 候选值：`resourceName=127.0.0.1:18443#`
- provider：`azure-openai`
- 测试 API key：`sk-local-provider-url`

结果：

| 场景 | Gateway 状态 | Mock 请求数 | 观察 |
|---|---:|---:|---|
| 对照值 | 500 | 0 | 连接到 `127.0.0.1.openai.azure.com:443`，未到达本机 mock |
| 片段候选值 | 200 | 1 | Mock 收到 `POST /`，Host 为 `127.0.0.1:18443` |

Mock 收到的关键请求头：

```text
host: 127.0.0.1:18443
api-key: sk-local-provider-url
```

这说明在 1.15.2 本地构建中，`resourceName` 中的 URL 结构字符可以改变最终连接目标，并导致 provider API key 发往本机控制的目标。该结果与 issue #1596 的描述一致，但本报告将其标记为 **F-8 候选发现**，仍需补充 Vertex、合法值边界和修复版本回归，不把它直接等同于已发布 CVE。

证据文件：

```text
../evidence/provider-url-injection-1792245900457.json
```

复现脚本：

```text
../reproduction/verify-provider-url-injection.mjs
```

## F-9：Retry 请求放大

本地 mock 对每次请求返回 `500`，Gateway 使用 `x-portkey-config` 设置 retry。结果如下：

| 配置 | Gateway 状态 | Mock 收到请求数 |
|---|---:|---:|
| 默认配置 | 500 | 1 |
| `attempts=3` | 500 | 4 |
| `attempts=5` | 500 | 6 |

每次重试都重新发送完整请求体，并继续携带同一个虚构 Authorization。当前证据确认“配置值会线性放大上游调用次数”，但这本身不等于漏洞：需要继续确认未授权客户端是否能够设置 retry config，以及是否存在配置上限、租户隔离和成本控制。

建议结论：先记录为 **可用性/成本放大候选**，不要直接标记为 SSRF 或认证绕过。

证据文件：

```text
../evidence/retry-amplification-1792246011339.json
```

复现脚本：

```text
../reproduction/verify-retry-amplification.mjs
```

## F-10：`/v1/responses` 流式响应异常

本地 mock 对 `stream=false` 返回 JSON，对 `stream=true` 返回最小 SSE。相同 provider、custom host 和虚构 Authorization 下：

| 模式 | Gateway 状态 | Mock 请求数 | 关键日志 |
|---|---:|---:|---|
| `stream=false` | 200 | 1 | 正常返回 response JSON |
| `stream=true` | 500 | 1 | `TypeError: immutable`，发生在 `responseService.updateHeaders` |

该结果与公开 issue #1550 的描述一致。当前测试证明的是流式响应处理失败和潜在重试/连接影响；没有证明远程代码执行、凭据泄露或跨租户数据读取。

证据文件：

```text
../evidence/stream-responses-1792245921685.json
```

复现脚本：

```text
../reproduction/verify-stream-responses.mjs
```

## F-6：未认证 `/log/stream` 日志泄露

这是独立于 SSRF 的高优先级发现。准确的 `@portkey-ai/gateway@1.15.2`/`ca771294` 构建在默认开发模式下注册 `/log/stream`，该路由没有 admin authentication middleware。

本地验证使用无凭证 `GET /log/stream`，随后向本机 mock 发出带虚构 provider key 和提示词标记的请求。结果如下：

| 项目 | 结果 |
|---|---|
| `/log/stream` 状态 | `200` |
| provider key 是否出现 | 是，`2` 次 |
| 提示词标记是否出现 | 是，`3` 次 |
| 日志中可见内容 | `providerOptions.apiKey`、`requestURL`、原始提示词、转换后的 Authorization |

SSE 日志样本包含以下结构：

```json
{
  "providerOptions": {
    "provider": "openai",
    "apiKey": "SECRET-PROBE-LOCAL-ABC123",
    "requestURL": "http://127.0.0.1:19030/chat/completions"
  },
  "finalUntransformedRequest": {
    "body": {
      "messages": [{"role": "user", "content": "PROMPT-PROBE-LOCAL-XYZ789"}]
    }
  }
}
```

该结果说明：只要攻击者能够访问本地开发模式 Gateway 的日志流，就可以被动读取调用者 provider key、请求 URL 和提示词原文，不需要构造 SSRF payload。该问题应与 F-1 分开评级和披露。

版本边界：GitHub release 显示 `v1.15.2` 对应提交 `ca77129`；后续 PR #1657 在 `/log/stream` 加入 admin authentication，并对 provider options 和 headers 做脱敏。因此这是 1.15.2 的版本缺口/backport gap，不能把当前 `main` 的修复状态倒推到 1.15.2。

来源：[v1.15.2 start-server.ts](https://github.com/Portkey-AI/gateway/blob/ca771294/src/start-server.ts)、[PR #1657](https://github.com/Portkey-AI/gateway/pull/1657)。

证据文件：

```text
../evidence/log-stream-exposure-1792246679772.json
```

复现脚本：

```text
../reproduction/verify-log-stream-exposure.mjs
```

## 本轮限制

1. F-8 使用本机自签名 HTTPS mock，并通过测试进程环境变量关闭 TLS 校验；这只用于隔离验证。
2. F-9 的放大测试没有并发运行，也没有连接真实 provider，因此没有测量实际费用。
3. F-10 的 SSE 是最小格式，尚未覆盖多事件、提前断流、慢速流和客户端重连。
4. 三项测试都没有使用此前暴露的真实 API key；所有请求头中的 key 都是虚构值。

## 下一步回归

- F-8：补充 Vertex `vertexRegion`、`vertexProjectId` 和 URL 编码字符矩阵；
- F-9：确认普通客户端是否能控制 retry/fallback 配置，并加入上限测试；
- F-10：增加提前断流、慢速 SSE、多个客户端连接和修复版本对照；
- 获取维护者修复版本后，使用相同脚本进行前后对比。

来源：[Portkey issue #1596](https://github.com/Portkey-AI/gateway/issues/1596)、[Portkey issue #1550](https://github.com/Portkey-AI/gateway/issues/1550)。
