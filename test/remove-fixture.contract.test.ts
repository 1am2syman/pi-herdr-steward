import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeFixture } from "./remove-fixture.ts";

it("removes protected fixture directories without following external symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "steward-cleanup-fixture-"));
	const external = await mkdtemp(join(tmpdir(), "steward-external-fixture-"));
	try {
		await writeFile(join(external, "keep"), "untouched");
		await mkdir(join(root, "protected"));
		await writeFile(join(root, "protected", "evidence"), "protected", { mode: 0o400 });
		await symlink(external, join(root, "protected", "foreign"));
		await chmod(join(root, "protected"), 0o500);
		await removeFixture(root);
		expect(await stat(root).catch(() => undefined)).toBeUndefined();
		expect(await readFile(join(external, "keep"), "utf8")).toBe("untouched");
	} finally { await removeFixture(root); await removeFixture(external); }
});
