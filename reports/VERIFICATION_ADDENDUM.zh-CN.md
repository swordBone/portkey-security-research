# Portkey 安全审计报告核验附录

**核验日期：** 2026-10-15  
**核验对象：** `@portkey-ai/gateway@1.15.2` 本地生产构建  
**核验范围：** 复跑已有 CVE、源码静态检查、受安全上限保护的请求体剂量测试

## 核验结论

原有 F-1 已重新复现。F-2 的无请求体上限和内存随输入增长的趋势得到确认；本次直接运行生产构建观察到约 3.5–4.1 倍的 RSS 增量/输入，但独立复核观察到约 11 倍。两组结果受 `WorkingSet64`、`VmRSS`、运行模式和错误路径差异影响，不能把倍数或容量外推当成可移植结论。F-2 应统一表述为“无 body-limit 导致随输入规模增长的内存放大”。

F-3 的底层错误信息回传有源码依据，端口 22 的 `bad port` 特殊情况也已在 Node 运行时复核。原始 `8/8` 动态枚举数据位于独立审计工作区的 `sec-lab/data/measurements.csv`，不在当前仓库，当前仓库将其标记为外部复核证据。F-4 已由源码确认。F-5 应限定为“缺少 DNS 解析后的 IP 钉扎或重验证”，因为代码仍然包含对字面量私网和保留 IP 的检查；十进制 loopback 的关键是校验层与 fetch 层的规范化语义差异。

此前将 F-6 写成“无法确认”是因为把 post-1.15.2 的 `/public/auth` 变更与 1.15.2 混在了一起。对准确的 `ca771294`/1.15.2 构建复测后，`GET /log/stream` 无凭证返回 200，并将 provider key、requestURL 和提示词原文通过 SSE 返回；该问题独立于 SSRF，应作为高优先级日志泄露发现记录。F-7 的原表述过强：顶层 Zod 对象会剥离未知键，带 `catchall` 的嵌套对象才会保留部分危险键；目前没有发现可达的原型污染汇点。

## F-1 复跑结果

重新运行 `node .\\reproduction\\attack-portkey-local.mjs` 得到：

| 场景 | Gateway 状态 | Mock 请求数 | 关键证据 |
|---|---:|---:|---|
| 普通路由 + 非允许 custom host | 400 | 0 | `Invalid custom host` |
| proxy 路由 + 同一 custom host | 500 | 1 | 收到 `/v1/chat/completions` 和 `Bearer sk-local-client-forwarded` |
| 普通路由 + config custom host | 400 | 0 | `Invalid custom host` |
| proxy 路由 + config api_key | 500 | 1 | 收到 `Bearer sk-local-config-forwarded` |
| proxy 重定向 | 500 | 2 | 第二次 GET 仍带 Authorization |

完整结果见：

```text
../evidence/portkey-attack-1792030881945.json
```

## F-2 安全剂量测试

测试每个剂量前都会重启 Gateway。测试只使用本机上游 `127.0.0.1:19000`，RSS 达到 1536 MB 时自动中止，不执行终止性 OOM 测试。

| 请求体 | 基线 RSS MB | 峰值 RSS MB | 增量 MB | 增量/输入 | 请求后 RSS MB | 上游收到字节 |
|---:|---:|---:|---:|---:|---:|---:|
| 5 MB | 66.15 | 83.79 | 17.64 | 3.53× | 83.10 | 5,242,945 |
| 20 MB | 66.07 | 148.08 | 82.02 | 4.10× | 52.71 | 20,971,585 |
| 80 MB | 66.21 | 388.63 | 322.41 | 4.03× | 388.65 | 83,886,145 |

这些结果确认：请求体被完整接收并转发，内存峰值随输入规模近似线性增长，且 80 MB 请求结束后 RSS 未及时回落。本表的倍数仅属于本次测量环境，不能与其他采样指标直接比较，也不能支持“约 630 MB 必然打满机器”的容量外推。

原始结果文件：

```text
../evidence/body-size-verification-1792031175168.json
../evidence/body-size-verification-1792031194802.json
../evidence/body-size-verification-1792031218975.json
```

复测脚本：

```text
../reproduction/verify-body-size.mjs
```

## 源码核验要点

当前构建中可以观察到以下事实：

- `/v1/proxy/*` 注册为 `proxyHandler`，没有和 `/v1/*` 相同的校验中间件；
- proxy handler 直接调用 JSON、form-data 或 array-buffer 解析，没有发现 body-limit 中间件；
- proxy 异常响应包含底层 `e.message`；
- 默认 custom-host 集合包含 `localhost`、`127.0.0.1`、`::1` 和 `host.docker.internal`；
- custom-host 校验包含字面量 IP 的私网和保留地址检查，但没有 DNS 解析后重新验证；
- 没有找到 `/public/auth` 字符串或 rate-limit 实现；
- 根 config schema 使用 Zod `object`，默认剥离未知键；嵌套 `catchall` 对象的行为需要按具体字段单独评估。

## 对原报告的修改建议

1. F-2 改为“无 body-limit 导致随输入规模增长的内存放大”，删除绝对倍数和容量外推。
2. F-3 改为“错误信息回传已由源码确认；8/8 端口枚举来自独立审计工作区数据，当前仓库只保留外部复核说明”。
3. F-5 改为“hostname 校验后缺少 DNS/IP 钉扎或重验证”，同时保留“字面量私网 IP 会被拒绝”的限定。
4. F-6 改为独立的“未认证 `/log/stream` 日志泄露”，并附准确版本、运行模式和原始 SSE 证据。
5. F-7 改为“嵌套宽松 schema 保留部分危险键，但未发现污染汇点”，不要写成整个 config schema 都不剥离。
6. Word 版、CSV 和预览图必须放入当前工作区后，才能执行 DOCX 渲染和逐页视觉核验。
