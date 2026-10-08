import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Test teardown only: finalized evidence is deliberately read-only in production.
 * Restore directory write access without following symlinks before deleting a fixture. */
export async function removeFixture(root: string): Promise<void> {
	async function writableDirectories(path: string): Promise<void> {
		let info;
		try { info = await lstat(path); } catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) return;
		await chmod(path, info.mode | 0o700);
		for (const entry of await readdir(path)) await writableDirectories(join(path, entry));
	}
	await writableDirectories(root);
	await rm(root, { recursive: true, force: true });
}
