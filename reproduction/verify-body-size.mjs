import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, "package");
const gatewayPort = 8787;
const upstreamPort = 19000;
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
const maxRssMb = Number(process.env.MAX_GATEWAY_RSS_MB || 1536);
const sizesMb = (process.env.SIZES_MB || "5,20,80")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

function readRssMb(pid) {
  try {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    const bytes = Number(raw);
    return Number.isFinite(bytes) ? bytes / 1024 / 1024 : null;
  } catch {
    return null;
  }
}

async function readRssEventually(pid) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const rss = readRssMb(pid);
    if (rss !== null) return rss;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function startUpstream() {
  let receivedBytes = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      receivedBytes += chunk.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "body-size-check", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  return {
    server,
    receivedBytes: () => receivedBytes,
    ready: new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(upstreamPort, "127.0.0.1", resolve);
    }),
  };
}

function startGateway() {
  const child = spawn(process.execPath, [path.join(packageDir, "build", "start-server.js"), `--port=${gatewayPort}`, "--headless"], {
    cwd: packageDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NO_PROXY: "127.0.0.1,localhost",
      TRUSTED_CUSTOM_HOSTS: "allowed.example.com",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return child;
}

async function waitForGateway() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${gatewayBase}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Gateway did not become ready");
}

async function stopProcess(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runDose(sizeMb) {
  const upstream = startUpstream();
  await upstream.ready;
  const gateway = startGateway();
  try {
    await waitForGateway();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const baselineRssMb = await readRssEventually(gateway.pid);
    const content = "A".repeat(sizeMb * 1024 * 1024);
    const requestBody = JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content }] });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let peakRssMb = baselineRssMb;
    let exceededSafetyLimit = false;
    const sampler = setInterval(() => {
      const rss = readRssMb(gateway.pid);
      if (rss !== null) {
        peakRssMb = Math.max(peakRssMb ?? 0, rss);
        if (rss >= maxRssMb) {
          exceededSafetyLimit = true;
          controller.abort();
        }
      }
    }, 50);

    let status = null;
    let responseText = "";
    try {
      const response = await fetch(`${gatewayBase}/v1/proxy/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer sk-local-body-size-check",
          "x-portkey-provider": "openai",
          "x-portkey-custom-host": upstreamBase,
        },
        body: requestBody,
        signal: controller.signal,
      });
      status = response.status;
      responseText = (await response.text()).slice(0, 300);
    } catch (error) {
      responseText = error.message;
    } finally {
      clearTimeout(timeout);
      clearInterval(sampler);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const postRequestRssMb = readRssMb(gateway.pid);
    return {
      sizeMb,
      baselineRssMb,
      peakRssMb,
      postRequestRssMb,
      amplification: baselineRssMb && peakRssMb ? (peakRssMb - baselineRssMb) / sizeMb : null,
      gatewayStatus: status,
      response: responseText,
      upstreamReceivedBytes: upstream.receivedBytes(),
      exceededSafetyLimit,
      maxRssMb,
    };
  } finally {
    await stopProcess(gateway);
    await new Promise((resolve) => upstream.server.close(resolve));
  }
}

const results = [];
for (const sizeMb of sizesMb) {
  results.push(await runDose(sizeMb));
  console.log(JSON.stringify(results.at(-1)));
}

const outputDir = path.join(here, "results");
await mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `body-size-verification-${Date.now()}.json`);
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ outputPath, results }, null, 2));
