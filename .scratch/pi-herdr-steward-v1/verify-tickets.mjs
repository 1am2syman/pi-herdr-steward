import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const issuesDir = resolve(import.meta.dirname, "issues");
const files = readdirSync(issuesDir).filter((name) => /^\d{2}-.+\.md$/.test(name)).sort();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadTickets() {
  if (files.length !== 20) fail(`expected 20 tickets, found ${files.length}`);
  return files.map((file, index) => {
    const expectedNumber = index + 1;
    const number = Number(file.slice(0, 2));
    if (number !== expectedNumber) fail(`ticket numbering gap at ${file}`);
    const text = readFileSync(resolve(issuesDir, file), "utf8");
    const title = text.match(/^# (\d{2}) — (.+)$/m);
    const blockersLine = text.match(/^\*\*Blocked by:\*\* (.+)$/m)?.[1];
    if (!title || Number(title[1]) !== number) fail(`invalid title in ${file}`);
    if (!blockersLine) fail(`missing blockers in ${file}`);
    if (!/^\*\*Status:\*\* ready-for-agent$/m.test(text)) fail(`invalid status in ${file}`);
    if (!/^\*\*What to build:\*\* .+/m.test(text)) fail(`missing deliverable in ${file}`);
    if ((text.match(/^- \[ \] /gm) ?? []).length < 3) fail(`too few acceptance criteria in ${file}`);
    return { file, number, title: title[2], blockersLine, text };
  });
}

const tickets = loadTickets();
const corpus = tickets.map((ticket) => ticket.text).join("\n");
const mode = process.argv[2];

if (mode === "coverage") {
  const requiredTitles = [
    "Installable extension and empty Run status",
    "Configure recovery defaults and Model Plans",
    "Confirm and persist a new Run",
    "Dispatch one Builder durably",
    "Validate Builder evidence",
    "Run an independent Review",
    "Complete Review and rework cycles",
    "Integrate and complete a single-Task Run",
    "Monitor and advance without user reminders",
    "Resume and reconcile interrupted work",
    "Recover silent agents without disrupting long commands",
    "Apply transient retries and approved fallbacks",
    "Coordinate multiple Tasks",
    "Enforce Controller Session ownership and compaction continuity",
    "Recover interrupted or conflicted integration",
    "Recover interrupted final verification",
    "Revise an active Run explicitly",
    "Cancel and clean up Steward-owned resources",
    "Recover damaged or unfamiliar Run Journals",
    "Verify installation and the complete functional path",
  ];
  for (const title of requiredTitles) {
    if (!tickets.some((ticket) => ticket.title === title)) fail(`missing ticket: ${title}`);
  }
  const requiredConcepts = [
    "/steward status", "/steward config", "/steward start", "/steward resume",
    "/steward revise", "/steward cleanup", "Run Journal", "Model Plan",
    "waiting-external", "suspected-stall", "Completion Gate", "compaction",
    "same-family", "atomic", "read-only", "approved order", "activity log",
    "maximum active Task",
  ];
  for (const concept of requiredConcepts) {
    if (!corpus.includes(concept)) fail(`missing accepted concept: ${concept}`);
  }
  console.log("ticket coverage verification passed");
} else if (mode === "dependencies") {
  for (const ticket of tickets) {
    if (ticket.blockersLine.startsWith("None")) continue;
    const blockers = [...ticket.blockersLine.matchAll(/(?:^|; )([0-9]{2}) —/g)].map((match) => Number(match[1]));
    if (blockers.length === 0) fail(`unparseable blockers in ${ticket.file}`);
    for (const blocker of blockers) {
      if (blocker >= ticket.number) fail(`ticket ${ticket.number} has non-prior blocker ${blocker}`);
      if (!tickets.some((candidate) => candidate.number === blocker)) fail(`ticket ${ticket.number} has missing blocker ${blocker}`);
    }
  }
  console.log("ticket dependency verification passed");
} else if (mode === "testing") {
  const forbiddenTitles = [/^Build shared infrastructure$/i, /^Add unit tests/i, /^Increase coverage/i, /^Create adapters$/i];
  for (const ticket of tickets) {
    if (forbiddenTitles.some((pattern) => pattern.test(ticket.title))) fail(`horizontal or test-only ticket: ${ticket.file}`);
    if (/\bunit tests?\b/i.test(ticket.text)) fail(`unnecessary unit-test language in ${ticket.file}`);
    if (!/(targeted functional test|smoke test)/i.test(ticket.text)) fail(`missing targeted functional verification in ${ticket.file}`);
    if (ticket.text.length > 2200) fail(`ticket is too large for a focused worker context: ${ticket.file}`);
  }
  const standaloneTestTicket = tickets.find((ticket) => /^(Test|Add tests|Increase coverage|Build test)/i.test(ticket.title));
  if (standaloneTestTicket) fail(`standalone test ticket found: ${standaloneTestTicket.file}`);
  console.log("ticket testing verification passed");
} else {
  fail("usage: node .scratch/pi-herdr-steward-v1/verify-tickets.mjs <coverage|dependencies|testing>");
}
