import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const artifactPath = resolve(import.meta.dirname, "run-recovery.logic-prototype.html");
const designPath = resolve(root, "docs/design.md");
const html = readFileSync(artifactPath, "utf8");
const design = readFileSync(designPath, "utf8");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) fail(`missing ${label}: ${expected}`);
}

function verifyCoverage() {
  const found = [...html.matchAll(/data-case="(C\d{2})"/g)].map(match => match[1]);
  const expected = Array.from({ length: 70 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`);
  const missing = expected.filter(id => !found.includes(id));
  const unexpected = found.filter(id => !expected.includes(id));
  const duplicates = [...new Set(found.filter((id, index) => found.indexOf(id) !== index))];

  if (missing.length || unexpected.length || duplicates.length || found.length !== expected.length) {
    fail(`coverage mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"} duplicates=${duplicates.join(",") || "none"} count=${found.length}`);
  }
  console.log("coverage verification passed");
}

function verifyStates() {
  const required = [
    "pending · building · reviewing · reworking · approved · integrating · completed · cancelled",
    "prepared · active · awaiting-report · reported · ended-error · superseded · cancelled",
    "none · blocked · waiting-external · suspected-stall · recovering · needs-user",
    "Findings, conflict, failed check",
    "Approval binds only to reviewed SHA",
    "new SHA and fresh Review",
    "Linked replacement",
    "preserved worktree",
    "persist intended transition",
    "reconcile before the next action",
    "Exact range already integrated",
    "Partial or conflicted Git operation",
    "Verification dirties checkout",
    "Cancellation is durable first",
    "Unsupported schemaVersion"
  ];
  for (const phrase of required) assertIncludes(html, phrase, "state or transition");
  console.log("state verification passed");
}

function verifyStatic() {
  const forbidden = [/<script\b/i, /<button\b/i, /<form\b/i, /<input\b/i, /<select\b/i, /<textarea\b/i, /\sonclick\s*=/i, /\sonchange\s*=/i];
  for (const pattern of forbidden) {
    if (pattern.test(html)) fail(`static artifact contains forbidden application control: ${pattern}`);
  }
  assertIncludes(html, "This is not a product interface.", "static-document declaration");
  console.log("static artifact verification passed");
}

function verifySections() {
  const headings = [...design.matchAll(/^## (.+)$/gm)].map(match => match[1].trim());
  const mapped = [...html.matchAll(/data-source="([^"]+)"/g)].map(match => match[1]);
  const missing = headings.filter(heading => !mapped.includes(heading));
  if (missing.length) fail(`unmapped accepted design sections: ${missing.join(" | ")}`);
  console.log("design section verification passed");
}

const mode = process.argv[2];
if (mode === "coverage") verifyCoverage();
else if (mode === "states") verifyStates();
else if (mode === "static") verifyStatic();
else if (mode === "sections") verifySections();
else fail("usage: node verify-flow-atlas.mjs <coverage|states|static|sections>");
