import { describe, expect, it } from "vitest";

import { type ModelPlan } from "../src/config.ts";
import { classifyInfrastructureFact, decideReconciliation, replacementRetryOrdinal, selectTransientModel } from "../src/reconciliation.ts";

const plan: ModelPlan = {
	primary: { model: "provider/primary", thinkingLevel: "high" },
	fallbacks: [
		{ model: "provider/fallback-a", thinkingLevel: "medium" },
		{ model: "other/fallback-b", thinkingLevel: "low" },
	],
};

function inspections(available: boolean[] = [true, true, true]) {
	return [plan.primary, ...plan.fallbacks].map((choice, planIndex) => ({
		choice,
		available: available[planIndex] ?? false,
		diagnostics: available[planIndex] === false ? [{ code: "unavailable-model" }] : [],
	}));
}

describe("ticket-12 typed retry policy", () => {
	it.each([
		["provider/network", { stage: "agent-prompt" as const, code: "provider-network-interruption" }, "provider-network-interruption"],
		["startup", { stage: "agent-start" as const, code: "agent-startup-failure" }, "agent-startup-failure"],
		["Herdr command", { stage: "pane-split" as const, code: "herdr-command-failure" }, "herdr-command-failure"],
		["unexpected exit", { stage: "agent-runtime" as const, code: "agent_not_found", source: "exact-agent-missing" as const }, "unexpected-process-exit"],
	] as const)("classifies only the authoritative %s fact", (_label, input, kind) => {
		expect(classifyInfrastructureFact({ ...input, diagnostic: "structured adapter fact" })?.kind).toBe(kind);
	});

	it.each([
		{ stage: "agent-prompt" as const, code: "runner-error", diagnostic: "terminal said provider timeout" },
		{ stage: "agent-runtime" as const, code: "server_unavailable", diagnostic: "Herdr is unavailable" },
		{ stage: "agent-prompt" as const, code: "tests_failed", diagnostic: "non-zero test result" },
		{ stage: "agent-runtime" as const, code: "agent_not_found", diagnostic: "missing without exact observation" },
	])("does not classify prose, observability loss, or correctness facts", (fact) => {
		expect(classifyInfrastructureFact(fact)).toBeUndefined();
	});

	it.each([
		[0, 0, undefined],
		[1, 0, 1],
		[1, 1, undefined],
		[2, 0, 1],
		[2, 1, 2],
		[2, 2, undefined],
		[2, 3, undefined],
	] as const)("derives global replacement budget from links (limit=%i, used=%i)", (limit, used, expected) => {
		const links = Array.from({ length: used }, (_, index) => ({ kind: index === 0 ? "silent-agent-recovery" as const : "transient-recovery" as const, retryOrdinal: (index + 1) as 1 | 2, replacesAttemptId: `attempt-${index + 1}` }));
		expect(replacementRetryOrdinal(links, limit)).toBe(expected);
	});

	it("retries the current approved model first, then moves strictly forward", () => {
		const same = selectTransientModel({ actualModel: plan.primary, plan, inspections: inspections(), reason: "same-model-unavailable" });
		expect(same).toMatchObject({ kind: "same-model-first", planIndex: 0, choice: plan.primary });

		const fallback = selectTransientModel({ actualModel: plan.primary, plan, inspections: inspections(), reason: "same-model-retry-failed" });
		expect(fallback).toMatchObject({ kind: "approved-fallback", planIndex: 1, choice: plan.fallbacks[0], reason: "same-model-retry-failed" });
		if (fallback.kind === "approved-fallback") expect(fallback.skipped).toEqual([{ planIndex: 0, model: plan.primary.model, codes: ["same-model-retry-failed"] }]);

		const forward = selectTransientModel({ actualModel: plan.fallbacks[0], plan, inspections: inspections(), reason: "same-model-retry-failed" });
		expect(forward).toMatchObject({ kind: "approved-fallback", planIndex: 2, choice: plan.fallbacks[1] });
		const unavailable = selectTransientModel({ actualModel: plan.fallbacks[0], plan, inspections: inspections([true, false, false]), reason: "same-model-retry-failed" });
		expect(unavailable.kind).toBe("unavailable");
	});

	it("skips unavailable approved choices and respects Reviewer provider independence", () => {
		const skipped = selectTransientModel({ actualModel: plan.primary, plan, inspections: inspections([false, false, true]), reason: "same-model-unavailable" });
		expect(skipped).toMatchObject({ kind: "approved-fallback", planIndex: 2, choice: plan.fallbacks[1], reason: "same-model-unavailable" });
		if (skipped.kind === "approved-fallback") expect(skipped.skipped.map((item) => item.planIndex)).toEqual([0, 1]);

		const independent = selectTransientModel({ actualModel: plan.primary, plan, inspections: inspections(), reason: "same-model-unavailable", requireProviderDifferentFrom: "provider", allowSameProvider: false });
		expect(independent).toMatchObject({ kind: "approved-fallback", planIndex: 2, choice: plan.fallbacks[1] });
	});

	it("keeps correctness and ordered reconciliation outside transient classification", () => {
		expect(classifyInfrastructureFact({ stage: "agent-runtime", code: "scope-violation", diagnostic: "outside allowed scope" })).toBeUndefined();
		expect(classifyInfrastructureFact({ stage: "agent-runtime", code: "review-changes-required", diagnostic: "correctness finding" })).toBeUndefined();
		expect(decideReconciliation({ report: "valid", live: { kind: "missing" } })).toEqual({ kind: "report" });
		expect(decideReconciliation({ report: "invalid", live: { kind: "working", lifecycle: "working" } })).toEqual({ kind: "working-or-blocked", lifecycle: "working" });
	});
});
