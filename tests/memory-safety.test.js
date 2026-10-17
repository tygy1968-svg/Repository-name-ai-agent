import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
function extract(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "Expected server.js function boundaries");
  return source.slice(a, b);
}

test("saving a fact never deletes existing memory, even if embedding fails", async () => {
  const requests = [];
  const ctx = {
    SUPABASE_MEMORY_URL: "https://example.invalid/memory",
    SUPABASE_KEY: "test",
    console,
    getFactCategory: () => "brand",
    createEmbedding: async () => { throw new Error("embedding unavailable"); },
    fetch: async (url, opts) => { requests.push(opts.method); return { ok: true, status: 201 }; }
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbSaveFact(", "async function sbSearchMemory("), ctx);
  await assert.rejects(ctx.sbSaveFact("test-user", "Пользователь развивает бренд X"), /embedding unavailable/);
  assert.deepEqual(requests, []);
});

test("successful fact save only POSTs, never DELETEs", async () => {
  const requests = [];
  const ctx = {
    SUPABASE_MEMORY_URL: "https://example.invalid/memory",
    SUPABASE_KEY: "test",
    console,
    getFactCategory: () => "brand",
    createEmbedding: async () => [0.1, 0.2],
    fetch: async (_url, opts) => { requests.push(opts.method); return { ok: true, status: 201 }; }
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbSaveFact(", "async function sbSearchMemory("), ctx);
  await ctx.sbSaveFact("test-user", "Пользователь развивает бренд X");
  assert.deepEqual(requests, ["POST"]);
});

test("corrections are queried for the same user and type refuted", async () => {
  const urls = [];
  const ctx = {
    SUPABASE_MEMORY_URL: "https://example.invalid/memory",
    SUPABASE_KEY: "test",
    URLSearchParams,
    Math,
    Number,
    String,
    console,
    fetch: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => [{ type: "refuted", content: "старый бренд опровергнут" }] };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbGetRefutedMemory(", "async function sbGetIdentity("), ctx);
  const result = await ctx.sbGetRefutedMemory("test-user");
  assert.equal(result.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get("user_id"), "eq.test-user");
  assert.equal(url.searchParams.get("type"), "eq.refuted");
});

test("Telegram response context includes corrections before semantic memory", () => {
  const correction = source.indexOf('const correctionText = corrections.map');
  const relevant = source.indexOf('const relevantText = (relevant || []).map');
  assert.ok(correction >= 0 && relevant > correction);
  assert.match(source, /sbGetRefutedMemory\(userId, 20\)/);
  assert.match(source, /Никогда не утверждай опровергнутый факт/);
});

test("correction context is placed before relevant facts", () => {
  const code = source.slice(
    source.indexOf("    const correctionText = corrections.map"),
    source.indexOf("\n  } catch (e) {", source.indexOf("    const correctionText = corrections.map"))
  );
  assert.ok(code.includes("correctionText ?"));
  assert.ok(code.indexOf("correctionText ?") < code.indexOf("relevantText ?"));
  assert.ok(code.includes('.filter(Boolean).join('));
});

test("correction and obsolete fact both reach context, correction first", async () => {
  const start = source.indexOf("    const [relevant, corrections] = await Promise.all([");
  const end = source.indexOf("\n  } catch (e) {", start);
  assert.ok(start >= 0 && end > start);
  const ctx = {
    sbSearchMemory: async () => [{ content: "Previous assertion" }],
    sbGetRefutedMemory: async () => [{ content: "Previous assertion was refuted" }]
  };
  vm.createContext(ctx);
  const makeContext = vm.runInContext(
    "(async (userId, userText) => { let memoryContext = ''; " +
    source.slice(start, end) +
    "; return memoryContext; })", ctx
  );
  const output = await makeContext("example-user", "Question");
  assert.ok(output.indexOf("Previous assertion was refuted") <
    output.indexOf("РЕЛЕВАНТНЫЕ ЗАПИСИ"));
  assert.ok(output.includes("Previous assertion"));
});

test("failed correction retrieval does not silently return an empty list", async () => {
  const ctx = {
    SUPABASE_MEMORY_URL: "https://example.invalid/memory",
    SUPABASE_KEY: "test",
    URLSearchParams, Math, Number, String, console,
    fetch: async () => ({ ok: false, status: 503 })
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbGetRefutedMemory(", "async function sbGetIdentity("), ctx);
  await assert.rejects(ctx.sbGetRefutedMemory("example-user"), /Correction retrieval failed: HTTP 503/);
});

test("memory lookup failure marks remembered facts as unverified", () => {
  const start = source.indexOf("    const [relevant, corrections] = await Promise.all([");
  const end = source.indexOf("\n  let webContext = \"\";", start);
  assert.ok(start >= 0 && end > start);
  const snippet = source.slice(start, end);
  assert.match(snippet, /ПАМЯТЬ НЕ ПРОВЕРЕНА/);
  assert.match(snippet, /memoryContext = "ПАМЯТЬ НЕ ПРОВЕРЕНА/);
});

test("invalid correction response is rejected", async () => {
  const ctx = {
    SUPABASE_MEMORY_URL: "https://example.invalid/memory",
    SUPABASE_KEY: "test",
    URLSearchParams, Math, Number, String, Array, console,
    fetch: async () => ({ ok: true, json: async () => ({ unexpected: "shape" }) })
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbGetRefutedMemory(", "async function sbGetIdentity("), ctx);
  await assert.rejects(ctx.sbGetRefutedMemory("example-user"), /invalid data/);
});

test("vector search failure is not mistaken for empty memory", async () => {
  const ctx = {
    SUPABASE_URL: "https://example.invalid",
    SUPABASE_KEY: "test",
    console, String, Array,
    createEmbedding: async () => [0.1],
    fetch: async () => ({ ok: false, status: 503 })
  };
  vm.createContext(ctx);
  vm.runInContext(extract("async function sbSearchMemory(", "// ---------- CALL SESSIONS ----------"), ctx);
  await assert.rejects(ctx.sbSearchMemory("example-user", "question"), /Memory vector search failed: HTTP 503/);
});

test("correction outage suppresses retrieved memories in assembled context", async () => {
  const start = source.indexOf("  let memoryContext = \"\";\n  try {", source.indexOf("    const [recentKuziaInteractions, recentCallSessions]"));
  const end = source.indexOf("\n  let webContext = \"\";", start);
  assert.ok(start >= 0 && end > start);
  const ctx = {
    console: { error: () => {} },
    sbSearchMemory: async () => [{ content: "obsolete claim" }],
    sbGetRefutedMemory: async () => { throw new Error("database unavailable"); }
  };
  vm.createContext(ctx);
  const run = vm.runInContext(
    "(async (userId, userText) => {" + source.slice(start, end) +
    "; return memoryContext; })", ctx
  );
  const output = await run("test-user", "question");
  assert.match(output, /ПАМЯТЬ НЕ ПРОВЕРЕНА/);
  assert.doesNotMatch(output, /obsolete claim/);
});
