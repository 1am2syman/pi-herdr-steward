import { describe, expect, it } from "vitest";

import { createProcessAdapter } from "../src/adapters.ts";

describe("ticket-08 process envelope", () => {
	it("invokes exactly /bin/sh -c with the frozen command and cwd", async () => {
		const calls: unknown[] = [];
		const adapter = createProcessAdapter(async (...args) => {
			calls.push(args);
			return { stdout: "out", stderr: "err", code: 7, killed: false };
		});
		const result = await adapter.runApprovedVerification!({ cwd: "/tmp/repository", command: "npm test -- --runInBand" });
		expect(result).toEqual({ kind: "completed", code: 7, stdout: "out", stderr: "err", killed: false });
		expect(calls).toEqual([["/bin/sh", ["-c", "npm test -- --runInBand"], { cwd: "/tmp/repository" }]]);
	});

	it("preserves killed results and converts runner throws to an ambiguous envelope", async () => {
		const killed = createProcessAdapter(async () => ({ stdout: "", stderr: "", code: 143, killed: true }));
		expect(await killed.runApprovedVerification!({ cwd: "/tmp/repository", command: "true" })).toEqual({ kind: "completed", code: 143, stdout: "", stderr: "", killed: true });
		const thrown = createProcessAdapter(async () => { throw new Error("runner unavailable"); });
		expect(await thrown.runApprovedVerification!({ cwd: "/tmp/repository", command: "true" })).toEqual({ kind: "thrown", message: "runner unavailable" });
	});

	it("rejects an unsafe command envelope before reaching the runner", async () => {
		let called = false;
		const adapter = createProcessAdapter(async () => { called = true; return { stdout: "", stderr: "", code: 0, killed: false }; });
		const result = await adapter.runApprovedVerification!({ cwd: "/tmp/repository", command: " true" });
		expect(result.kind).toBe("thrown");
		expect(called).toBe(false);
	});
});
