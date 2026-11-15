import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractUrl,
  validateContent,
  validateImage,
  MAX_IMAGE,
} from "../src/lib/validation";
import { organizeWithRules } from "../src/lib/ai/rules";
import { organize } from "../src/lib/ai";
import { parseOrganization } from "../src/lib/ai/provider";
import {
  fetchUrlTitle,
  isPublicAddress,
  parseUrlTitle,
} from "../src/lib/url-title";

test("输入校验：空内容、文字上限、图片大小/格式、URL 提取", () => {
  assert.throws(() => validateContent(" "), /写点什么/);
  assert.equal(validateContent(" ", true), "");
  assert.throws(() => validateContent("a".repeat(50001)), /50,000/);
  assert.equal(
    extractUrl("稍后阅读 https://example.com/article?x=1。"),
    "https://example.com/article?x=1",
  );
  assert.equal(extractUrl("javascript:alert(1)"), null);
  assert.match(validateImage({ type: "image/svg+xml", size: 100 })!, /请选择/);
  assert.match(
    validateImage({ type: "image/png", size: MAX_IMAGE + 1 })!,
    /5 MB/,
  );
});

test("规则整理识别中文/英文、显式标签，纯图片摘要不编造内容", () => {
  const result = organizeWithRules({
    content: "用 Next.js 开发 AI 笔记。 #个人项目",
    title: null,
    source: "text",
    imageName: null,
  });
  assert.ok(result.tags.includes("个人项目"));
  assert.ok(result.tags.includes("AI"));
  assert.ok(result.tags.includes("开发"));
  assert.match(result.summary, /Next.js/);
  const image = organizeWithRules({
    content: "",
    title: null,
    source: "image",
    imageName: "cat.png",
  });
  assert.deepEqual(image.tags, ["图片收藏"]);
  assert.match(image.summary, /补充文字/);
  assert.doesNotMatch(image.summary, /猫/);
  assert.throws(() => parseOrganization({ tags: [], summary: "记录" }));
});

test("模型缺少 key 时回退规则，不影响整理结果", async () => {
  const previous = process.env.AI_PROVIDER;
  const key = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = "openai";
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await organize({
      content: "明天读书",
      title: null,
      source: "text",
      imageName: null,
    });
    assert.equal(result.status, "fallback");
    assert.equal(result.provider, "rules");
    assert.ok(result.tags.includes("阅读"));
  } finally {
    if (previous === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous;
    if (key !== undefined) process.env.OPENAI_API_KEY = key;
  }
});

test("网页标题解析实体/空白、OG 兜底；阻止私网和 IPv4 映射地址", async () => {
  assert.equal(
    parseUrlTitle("<title> Hello &amp;\n Spark </title>"),
    "Hello & Spark",
  );
  assert.equal(
    parseUrlTitle('<meta property="og:title" content="阅读笔记">'),
    "阅读笔记",
  );
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:192.168.1.1",
    "0.0.0.0",
    "fc00::1",
    "198.18.3.82",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(await fetchUrlTitle("http://127.0.0.1/secret"), null);
  assert.equal(await fetchUrlTitle("file:///etc/passwd"), null);
  assert.equal(await fetchUrlTitle("http://198.18.3.82/secret"), null);
});

test("SQLite：保存、重启连接可读、编辑版本冲突、重新整理、删除图片和记录", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "spark-unit-"));
  process.env.SPARK_DATA_DIR = directory;
  process.env.AI_PROVIDER = "rules";
  const {
    createEntry,
    getEntry,
    listEntries,
    updateEntry,
    deleteEntry,
    enrichEntry,
  } = await import("../src/lib/entries");
  const { getDb } = await import("../src/lib/db");
  try {
    const first = createEntry("明天阅读一本设计书");
    const image = createEntry("", {
      data: Buffer.from("test"),
      type: "image/png",
      name: "note.png",
    });
    assert.equal(listEntries()[0].id, image.id);
    await enrichEntry(first.id);
    assert.ok(getEntry(first.id)!.tags.includes("设计"));
    assert.equal(getEntry(first.id)!.status, "ready");
    const edited = updateEntry(first.id, "AI 编程 #灵感", first.version);
    assert.equal(edited.status, "pending");
    assert.throws(
      () => updateEntry(first.id, "不应覆盖", first.version),
      /其他页面更新/,
    );
    await enrichEntry(first.id);
    assert.ok(getEntry(first.id)!.tags.includes("AI"));
    const globalDb = globalThis as unknown as {
      sparkDb?: import("better-sqlite3").Database;
    };
    getDb().close();
    delete globalDb.sparkDb;
    assert.equal(getEntry(first.id)!.content, "AI 编程 #灵感");
    assert.equal(getEntry(image.id)!.source, "image");
    deleteEntry(first.id);
    deleteEntry(image.id);
    assert.equal(listEntries().length, 0);
    assert.equal(getEntry(image.id), null);
    getDb().close();
    delete globalDb.sparkDb;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
