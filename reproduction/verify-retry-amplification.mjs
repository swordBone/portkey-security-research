import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, "package");
const gatewayPort = 8787;
const mockPort = 19020;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const requests = [];

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "controlled local failure" } }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  const child = spawn(process.execPath, [path.join(packageDir, "build", "start-server.js"), `--port=${gatewayPort}`, "--headless"], {
    cwd: packageDir,
    env: { ...process.env, NODE_ENV: "production", NO_PROXY: "127.0.0.1,localhost", TRUSTED_CUSTOM_HOSTS: "127.0.0.1,localhost" },
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

async function call(label, config) {
  const before = requests.length;
  try {
    const response = await fetch(`${gatewayBase}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-portkey-config": JSON.stringify(config),
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: `local ${label}` }] }),
      signal: AbortSignal.timeout(45000),
    });
    return { label, status: response.status, body: (await response.text()).slice(0, 500), requests: requests.slice(before) };
  } catch (error) {
    return { label, error: error.message, requests: requests.slice(before) };
  }
}

let mock;
let gateway;
try {
  mock = await startMock();
  gateway = startGateway();
  await waitForGateway(gateway.logs);
  const base = { provider: "openai", api_key: "sk-local-retry", custom_host: `http://127.0.0.1:${mockPort}` };
  const results = {
    default: await call("default", base),
    attempts_3: await call("attempts-3", { ...base, retry: { attempts: 3, on_status_codes: [500] } }),
    attempts_5: await call("attempts-5", { ...base, retry: { attempts: 5, on_status_codes: [500] } }),
  };
  const outputDir = path.join(__dirname, "..", "evidence");
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, `retry-amplification-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), package: "@portkey-ai/gateway@1.15.2", results, gatewayLogs: gateway.logs.join("").slice(-8000) }, null, 2));
  console.log(JSON.stringify({ resultPath, summary: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { status: value.status, upstreamRequests: value.requests.length }])) }, null, 2));
} finally {
  if (gateway?.child && !gateway.child.killed) gateway.child.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
}
