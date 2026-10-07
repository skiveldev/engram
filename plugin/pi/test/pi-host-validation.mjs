// Explicit SDK integration entrypoint; never included by the default *.test.mjs glob.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = process.env.ENGRAM_PI_SDK_ROOT;
assert.ok(sdkRoot && existsSync(join(sdkRoot, "dist/index.js")),
  "ENGRAM_PI_SDK_ROOT must name an installed Pi SDK; this integration never skips or installs dependencies");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
const scratch = join(common, "gentle-checks/t2-parity");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "sdk-"));
// Discard ambient provider credentials BEFORE importing the SDK. Keep only the
// authorized offline Go runner controls; all host discovery roots are isolated.
const keep = new Set(["PATH", "TMPDIR", "GOTMPDIR", "GOCACHE", "GOMODCACHE", "GOROOT", "GOPROXY", "GOSUMDB", "GOTOOLCHAIN", "GOFLAGS"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, { HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1" });
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
const require = createRequire(join(sdkRoot, "package.json"));
const { Type } = require("typebox");

test("real Pi host converts fractional max_bytes and rejects nonpositive values before handler dispatch", { timeout: 120000 }, async (t) => {
  const child = spawn("go", ["test", "./internal/mcp", "-run", "^TestPiAgentContractBridge$", "-count=1"], {
    cwd: root, env: { ...process.env, ENGRAM_PARITY_BRIDGE: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let url, session, provider;
  const requests = [];
  let input, observed;
  try {
    for (let n = 0; n < 600 && !existsSync(join(dir, "url")); n++) {
      assert.equal(child.exitCode, null, output);
      await delay(100);
    }
    assert.ok(existsSync(join(dir, "url")), `real core bridge unavailable: ${output}`);
    url = readFileSync(join(dir, "url"), "utf8");
    process.env.ENGRAM_URL = url;
    const get = async (path) => {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const snapshot = async () => {
      const exported = await get("/export?all_projects=true");
      assert.ok(Array.isArray(exported.sessions));
      assert.ok(exported.sessions.some((entry) => entry.id === "parity-sdk-seed" && entry.project === "parity"));
      const { exported_at, ...data } = exported;
      assert.equal(typeof exported_at, "string", "export includes generation metadata");
      assert.ok(Number.isFinite(Date.parse(exported_at)), "export generation timestamp is valid");
      // Only generation metadata varies between reads; retain every stored field.
      return { stats: await get("/stats?all_projects=true"), data };
    };
    const seed = await fetch(`${url}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "parity-sdk-seed", project: "parity" }) });
    assert.equal(seed.status, 201, await seed.text());
    provider = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ path: request.url, payload });
      const finished = payload.messages.at(-1)?.role === "tool";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = finished ? { content: "done" } : { role: "assistant", tool_calls: [{ index: 0, id: `helper-${requests.length}`, type: "function", function: { name: "host_probe", arguments: "{}" } }] };
      response.end(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const config = {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "offline-dummy",
      models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const helper = (pi) => {
      pi.registerProvider("parity-loopback", config);
      pi.registerTool({ name: "host_probe", label: "Host probe", description: "Dispatch the test input", parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          const before = await snapshot();
          const countsBefore = await get("/fixture/requests");
          const queriesBefore = await get("/fixture/context-queries");
          let result, error;
          try { result = await ctx.executeTool("mem_context", input); } catch (caught) { error = caught.message; }
          observed = { before, after: await snapshot(), countsBefore, countsAfter: await get("/fixture/requests"), queriesBefore, queriesAfter: await get("/fixture/context-queries"), result, error };
          return { content: [{ type: "text", text: "probe complete" }], details: undefined };
        },
      });
    };
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(root, "plugin/pi/index.ts")], extensionFactories: [helper], systemPrompt: "Offline host test", appendSystemPrompt: [],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 2);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    // Explicit physical model; the provider factory registers the compatible API.
    const model = { ...config.models[0], type: "chat", provider: "parity-loopback", api: config.api, baseUrl: config.baseUrl };
    ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: join(dir, "agent"), modelRuntime, model, thinkingLevel: "off",
      resourceLoader, settingsManager, sessionManager: sdk.SessionManager.inMemory(dir), tools: ["host_probe", "mem_context"],
    }));
    const errors = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
    const startup = await snapshot();
    for (const value of [1.5, 0, -1, 1, 1000000000]) {
      input = { project: "parity", max_bytes: value };
      observed = undefined;
      const requestCount = requests.length;
      await session.prompt("probe");
      assert.ok(observed, `assistant-issued helper must execute: ${JSON.stringify({ messages: session.messages, requests, errors })}`);
      assert.equal(requests.length - requestCount, 2, "one helper call and one finishing response");
      assert.deepEqual(observed.after, observed.before, "nested dispatch leaves public stored data/counters unchanged");
      const contexts = (observed.countsAfter["GET /context"] ?? 0) - (observed.countsBefore["GET /context"] ?? 0);
      const received = observed.queriesAfter.slice(observed.queriesBefore.length);
      t.diagnostic(JSON.stringify({ max_bytes: value, error: observed.error, result: observed.result, contextRequests: contexts, receivedMaxBytes: received, providerRequests: 2 }));
      if (value <= 0) {
        assert.equal(observed.error, undefined, "nested failures are returned, not thrown");
        assert.equal(observed.result.isError, true, "host must return validation failure");
        assert.match(JSON.stringify(observed.result.result.content), /max_bytes/);
        assert.equal(contexts, 0);
        assert.deepEqual(received, [], "rejected inputs never reach the context handler");
      } else {
        assert.equal(observed.error, undefined);
        assert.equal(contexts, 1, "validated arguments must reach the real core handler");
        assert.deepEqual(received, [String(Math.trunc(value))], "HTTP receives the converted integer");
        assert.equal(observed.result.isError, false);
        assert.equal(observed.result.result.content[0].type, "text");
      }
    }
    assert.deepEqual(errors, [], "ordinary extension hooks remain enabled");
    t.diagnostic(JSON.stringify({ startup, settled: await snapshot(), requests: await get("/fixture/requests") }));
    assert.ok(requests.every((request) => request.path === "/v1/chat/completions"));
  } finally {
    session?.dispose();
    if (provider) await new Promise((resolve) => provider.close(resolve));
    if (url) await fetch(`${url}/stop`, { method: "POST" });
    assert.equal(await exited, 0, output);
  }
});
