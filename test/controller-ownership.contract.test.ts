import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { it, vi } from "vitest";

const { compactMock } = vi.hoisted(() => ({ compactMock: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
	return { ...actual, compact: compactMock };
});

import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compactWithStewardContinuity } from "../src/adapters.ts";
import { registerStewardExtension, type StewardRegistrationSurface } from "../src/extension.ts";

it("forwards the Pi 0.84.4 compaction protocol and preserves the complete result", async () => {
	const preparation = { branchEntries: [] } as unknown as SessionBeforeCompactEvent["preparation"];
	const signal = new AbortController().signal;
	const model = { provider: "provider", id: "model", name: "Model" } as NonNullable<ExtensionContext["model"]>;
	const sessionId = "pi-session-contract";
	const ctx = {
		model,
		thinkingLevel: "high",
		modelRegistry: {
			async getApiKeyAndHeaders() { return { ok: true as const, apiKey: "api-key", headers: { "x-test": "header", "x-null": null }, env: { TEST_ENV: "yes" } }; },
		},
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as Parameters<typeof compactWithStewardContinuity>[1];
	const event = {
		type: "session_before_compact" as const,
		preparation,
		branchEntries: [],
		customInstructions: "retain the user's instructions",
		reason: "overflow" as const,
		willRetry: true,
		signal,
	};
	const usage = { input: 10, output: 4, totalTokens: 14 };
	compactMock.mockResolvedValueOnce({ summary: "model summary", firstKeptEntryId: "entry-7", tokensBefore: 123, estimatedTokensAfter: 21, usage, details: { marker: "preserve" } });
	const continuity = "Steward Run: run-contract\nVerified Journal revision: 9\nController Session: pi-session-contract\nPending Controller action: admit-task task-01\nAuthoritative recovery source: .pi/steward/active-run.json; reconcile before mutation.";
	const result = await compactWithStewardContinuity(event, ctx, continuity);
	equal(compactMock.mock.calls.length, 1);
	const args = compactMock.mock.calls[0] as unknown[];
	deepStrictEqual(args[0], preparation);
	deepStrictEqual(args[1], model);
	equal(args[2], "api-key");
	deepStrictEqual(args[3], { "x-test": "header" });
	equal(args[4], `retain the user's instructions\n\n${continuity}`);
	equal(args[5], signal);
	equal(args[6], "high");
	deepStrictEqual(args[8], { TEST_ENV: "yes" });
	equal(args[11], sessionId);
	equal(result.firstKeptEntryId, "entry-7");
	equal(result.tokensBefore, 123);
	equal(result.estimatedTokensAfter, 21);
	deepStrictEqual(result.usage, usage);
	deepStrictEqual(result.details, { marker: "preserve" });
	equal(result.summary, `model summary\n\n${continuity}`);
});

it("registers exactly one Steward command and only the official lifecycle hooks", () => {
	const events: string[] = [];
	const commands: string[] = [];
	const surface: StewardRegistrationSurface = {
		on(name, _handler) { events.push(name); },
		registerCommand(name, _options) { commands.push(name); },
	};
	registerStewardExtension(surface, () => { throw new Error("adapter factory must not run while registering"); });
	deepStrictEqual(commands, ["steward"]);
	deepStrictEqual(events, ["session_start", "agent_start", "turn_start", "turn_end", "agent_settled", "session_before_compact", "session_compact", "session_compact_failed", "ui_prompt_start", "ui_prompt_end", "session_shutdown"]);
	ok(!events.includes("session_before_switch"));
	ok(!events.includes("session_before_fork"));
});
