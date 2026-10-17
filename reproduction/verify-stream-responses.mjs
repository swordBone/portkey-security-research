import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, "package");
const gatewayPort = 8791;
const mockPort = 19010;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const requests = [];

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" });
      res.write('data: {"type":"response.created","response":{"id":"resp_local","object":"response","status":"in_progress"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","item_id":"msg_local","output_index":0,"content_index":0,"delta":"ok"}\n\n');
      res.write('data: {"type":"response.completed","response":{"id":"resp_local","object":"response","status":"completed"}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "response-local", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
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

async function call(stream) {
  const before = requests.length;
  const response = await fetch(`${gatewayBase}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-local-stream",
      "x-portkey-provider": "openai",
      "x-portkey-custom-host": `http://127.0.0.1:${mockPort}`,
    },
    body: JSON.stringify({ model: "gpt-4o-mini", input: "local probe", stream }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 1000), requests: requests.slice(before) };
}

let mock;
let gateway;
try {
  mock = await startMock();
  gateway = startGateway();
  await waitForGateway(gateway.logs);
  const results = { stream_false: await call(false), stream_true: await call(true) };
  const outputDir = path.join(__dirname, "..", "evidence");
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, `stream-responses-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), package: "@portkey-ai/gateway@1.15.2", results, gatewayLogs: gateway.logs.join("").slice(-8000) }, null, 2));
  console.log(JSON.stringify({ resultPath, summary: Object.fromEntries(Object.entries(results).map(([name, value]) => [name, { status: value.status, mockRequestCount: value.requests.length, bodyPrefix: value.body.slice(0, 120) }])) }, null, 2));
} finally {
  if (gateway?.child && !gateway.child.killed) gateway.child.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
}
