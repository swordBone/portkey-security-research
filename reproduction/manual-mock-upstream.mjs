import http from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.MOCK_PORT || 18080);
const host = "127.0.0.1";
const altLoopback = `http://2130706433:${port}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, "results");
const logPath = path.join(logDir, "manual-mock-upstream.jsonl");

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const record = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  };

  console.log("\n--- incoming request ---");
  console.log(`${req.method} ${req.url}`);
  console.log(JSON.stringify(req.headers, null, 2));
  if (body) console.log(body);
  await mkdir(logDir, { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`);

  if (req.url.includes("redirect-to-alt")) {
    res.writeHead(302, {
      location: `${altLoopback}/redirected-from-allowed-host`,
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

server.listen(port, host, () => {
  console.log(`manual mock upstream listening at http://${host}:${port}`);
  console.log(`alternate loopback form: ${altLoopback}`);
  console.log(`request log file: ${logPath}`);
});
