import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

test("every page references the same cache-versioned theme stylesheet", () => {
  const directory = new URL("../static/", import.meta.url);
  const pages = readdirSync(directory).filter((name) => name.endsWith(".html"));
  const references = new Set<string>();
  assert.ok(pages.length > 0);
  for (const name of pages) {
    const html = readFileSync(new URL(name, directory), "utf8");
    const links = [...html.matchAll(/href="(\/static\/themes\.css[^"]*)"/g)];
    assert.equal(links.length, 1, `${name} must load the shared stylesheet once`);
    assert.match(links[0][1], /^\/static\/themes\.css\?v=[a-zA-Z0-9.-]+$/, name);
    references.add(links[0][1]);
  }
  assert.equal(references.size, 1, "all pages must use the same theme revision");
});
