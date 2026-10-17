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
