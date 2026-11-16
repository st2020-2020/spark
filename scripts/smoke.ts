import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Entry } from "../src/lib/types";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "spark-smoke-"));
  const port = process.env.SPARK_TEST_PORT || "3101";
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let logs = "";
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function start() {
    server = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        port,
      ],
      {
        env: {
          ...process.env,
          SPARK_DATA_DIR: directory,
          AI_PROVIDER: "rules",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout!.on("data", (chunk) => {
      logs += chunk;
    });
    server.stderr!.on("data", (chunk) => {
      logs += chunk;
    });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(base)).ok) return;
      } catch {
        /* Wait for readiness. */
      }
      await pause(200);
    }
    throw new Error(`Server did not start: ${logs}`);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  async function create(content: string, image?: Blob) {
    const data = new FormData();
    data.set("content", content);
    if (image) data.set("image", image, "spark.png");
    const response = await fetch(`${base}/api/entries`, {
      method: "POST",
      headers: { Origin: base },
      body: data,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).entry as Entry;
  }
  async function settled(id: string) {
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${base}/api/entries/${id}`);
      const entry = (await response.json()).entry as Entry;
      if (entry.status !== "pending") return entry;
      await pause(200);
    }
    throw new Error("Organization did not complete");
  }

  try {
    await start();
    assert.deepEqual(
      (await (await fetch(`${base}/api/entries`)).json()).entries,
      [],
    );
    console.log("✓ production server + empty inbox");
    const text = await create("明天用 Next.js 开发 AI 灵感笔记 #个人项目");
    const organized = await settled(text.id);
    assert.ok(organized.tags.includes("AI"));
    assert.ok(organized.summary);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=",
      "base64",
    );
    const image = await create(
      "设计参考",
      new Blob([png], { type: "image/png" }),
    );
    const servedImage = await fetch(`${base}${image.imageUrl}`);
    assert.equal(servedImage.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await servedImage.arrayBuffer()), png);
    const list = (await (await fetch(`${base}/api/entries`)).json()).entries;
    assert.equal(list[0].id, image.id);
    console.log(
      "✓ create text/image + newest first + automatic tags/summary + binary image retrieval",
    );
    const link = await create("https://example.com");
    const titled = await settled(link.id);
    assert.match(
      titled.title || "",
      /Example Domain/i,
      `Expected fetched title; got ${JSON.stringify(titled.title)}`,
    );
    console.log(`✓ URL fetched title: ${titled.title}`);
    const patch = await fetch(`${base}/api/entries/${text.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        content: "周末去旅行，记录美食。",
        version: text.version,
      }),
    });
    assert.equal(patch.status, 200);
    const conflict = await fetch(`${base}/api/entries/${text.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "旧版本不能覆盖",
        version: text.version,
      }),
    });
    assert.equal(conflict.status, 409);
    assert.ok((await settled(text.id)).tags.includes("生活"));
    console.log("✓ edit + re-organize + stale version conflict");
    const empty = new FormData();
    empty.set("content", " ");
    assert.equal(
      (await fetch(`${base}/api/entries`, { method: "POST", body: empty }))
        .status,
      400,
    );
    const badImage = new FormData();
    badImage.set("content", "invalid");
    badImage.set(
      "image",
      new Blob(["not png"], { type: "image/png" }),
      "bad.png",
    );
    assert.equal(
      (await fetch(`${base}/api/entries`, { method: "POST", body: badImage }))
        .status,
      400,
    );
    for (const origin of [
      "https://other.example",
      `http://localhost:${port}`,
      `http://127.0.0.1:${Number(port) + 1}`,
      `https://127.0.0.1:${port}`,
    ]) {
      assert.equal(
        (
          await fetch(`${base}/api/entries/${image.id}`, {
            method: "DELETE",
            headers: { Origin: origin },
          })
        ).status,
        403,
        `Cross-origin request must be rejected: ${origin}`,
      );
    }
    console.log("✓ empty input / invalid image / cross-origin rejection");
    await stop();
    await start();
    assert.equal(
      (await (await fetch(`${base}/api/entries/${text.id}`)).json()).entry
        .content,
      "周末去旅行，记录美食。",
    );
    assert.ok((await fetch(`${base}/entries/${text.id}`)).ok);
    console.log(
      "✓ SQLite persists across production server restart + detail renders",
    );
    for (const id of [text.id, image.id, link.id])
      assert.equal(
        (
          await fetch(`${base}/api/entries/${id}`, {
            method: "DELETE",
            headers: { Origin: base },
          })
        ).status,
        204,
      );
    assert.equal(
      (await fetch(`${base}/api/entries/${image.id}/image`)).status,
      404,
    );
    assert.equal((await fetch(`${base}/api/entries/${text.id}`)).status, 404);
    assert.equal(
      (await (await fetch(`${base}/api/entries`)).json()).entries.length,
      0,
    );
    console.log("✓ delete removes entry and image; missing records return 404");
    console.log("PASS: production integration smoke test");
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
