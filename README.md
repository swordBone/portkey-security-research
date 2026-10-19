# Portkey Gateway Security Research

本仓库保存 Portkey AI Gateway `@portkey-ai/gateway@1.15.2` 的本地安全研究材料，重点覆盖 `CVE-2026-82270 / GHSA-rv66-rgwx-xfrj`、`/v1/proxy/*` 的 SSRF allowlist 绕过、provider URL 组件注入、未认证日志流敏感信息暴露、重试请求放大、流式响应异常，以及请求体内存放大核验。

所有动态测试均面向本机 mock upstream，使用 `sk-local-*` 虚构测试值，不包含真实 provider key。仓库默认用于私有研究和负责任披露。公开 PoC 前请先联系维护者并完成脱敏。

## 目录

- `reports/`：阶段报告、攻击验证报告和核验附录
- `reproduction/`：Node.js、PowerShell 复现脚本和中文操作指南
- `reproduction/package/`：用于本地复现的 1.15.2 Gateway build 与包元数据，不包含 `node_modules`
- `evidence/`：已保存的 JSON 结果和安全剂量测试数据
- `reports/REVIEW_ROUND2_ADDENDUM.zh-CN.md`：第二轮独立复核的整合说明，明确本机证据与外部复核边界

## 快速开始

```powershell
cd .\reproduction\package
npm install --omit=dev --ignore-scripts
cd ..\..
node .\reproduction\attack-portkey-local.mjs
```

手工 payload：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\reproduction\repro-cve-2026-82270-payloads.ps1 -Case all
```

请求体剂量测试带有 1536 MB RSS 安全上限，不执行终止性 OOM 测试：

```powershell
$env:SIZES_MB = "5,20,80"
node .\reproduction\verify-body-size.mjs
```

## 主要来源

- [GitHub Advisory GHSA-rv66-rgwx-xfrj](https://github.com/advisories/GHSA-rv66-rgwx-xfrj)
- [Portkey issue #1718](https://github.com/Portkey-AI/gateway/issues/1718)
- [Portkey Gateway](https://github.com/Portkey-AI/gateway)

## 披露说明

本仓库记录的是隔离环境中的验证结果。结果中的 `Authorization` 值均为本地虚构值。若要公开仓库，请先删除或替换可用于复现未修复漏洞的细节，并确认维护者已收到负责任披露。
