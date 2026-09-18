import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, lstat, unlink, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const STEWARD_DIRECTORY_NAME = "steward";
export const STEWARD_SENTINEL_NAME = ".gitignore";
export const STEWARD_SENTINEL_CONTENT = "*\n";

export interface ProjectStatePaths {
	configDirectory: string;
	stewardDirectory: string;
	sentinelPath: string;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Unknown filesystem error.";
}

export function resolveProjectStatePaths(repositoryRoot: string, configDirName = CONFIG_DIR_NAME): ProjectStatePaths {
	const configDirectory = join(repositoryRoot, configDirName);
	const stewardDirectory = join(configDirectory, STEWARD_DIRECTORY_NAME);
	return { configDirectory, stewardDirectory, sentinelPath: join(stewardDirectory, STEWARD_SENTINEL_NAME) };
}

async function ensureRegularDirectory(path: string, mode: number, chmodExisting = true): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isDirectory()) throw new Error(`Steward-owned path is not a directory: ${path}`);
		if (chmodExisting) await chmod(path, mode).catch(() => undefined);
		return;
	} catch (error: unknown) {
		if (!isMissing(error)) throw error;
	}
	try {
		await mkdir(path, { mode });
	} catch (error: unknown) {
		if (!errorCode(error) || errorCode(error) !== "EEXIST") throw error;
		const info = await lstat(path);
		if (!info.isDirectory()) throw new Error(`Steward-owned path is not a directory: ${path}`);
	}
	if (chmodExisting) await chmod(path, mode).catch(() => undefined);
}

async function ensureRegularFile(path: string, mode: number): Promise<void> {
	const info = await lstat(path);
	if (!info.isFile()) throw new Error(`Steward-owned path is not a regular file: ${path}`);
	await chmod(path, mode).catch(() => undefined);
}

/** Create or validate the project-local Steward directory and exact self-ignore sentinel. */
export async function ensureProjectStateDirectory(repositoryRoot: string, configDirName = CONFIG_DIR_NAME): Promise<ProjectStatePaths> {
	const paths = resolveProjectStatePaths(repositoryRoot, configDirName);
	await ensureRegularDirectory(paths.configDirectory, 0o700, false);
	await ensureRegularDirectory(paths.stewardDirectory, 0o700);
	try {
		await ensureRegularFile(paths.sentinelPath, 0o600);
		if ((await readFile(paths.sentinelPath, "utf8")) !== STEWARD_SENTINEL_CONTENT) {
			throw new Error(`Existing Steward sentinel has unexpected content at ${paths.sentinelPath}.`);
		}
	} catch (error: unknown) {
		if (!isMissing(error)) throw error;
		try {
			const handle = await open(paths.sentinelPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				await handle.writeFile(STEWARD_SENTINEL_CONTENT, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (error: unknown) {
			if (errorCode(error) !== "EEXIST") throw error;
			await ensureRegularFile(paths.sentinelPath, 0o600);
			if ((await readFile(paths.sentinelPath, "utf8")) !== STEWARD_SENTINEL_CONTENT) throw new Error(`Existing Steward sentinel has unexpected content at ${paths.sentinelPath}.`);
		}
	}
	return paths;
}

export async function ensureOwnedDirectory(path: string): Promise<void> {
	await ensureRegularDirectory(path, 0o700);
}

export async function createOwnedTemporaryFile(directory: string, prefix: string, content: string): Promise<string> {
	const temporaryPath = join(directory, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error: unknown) {
		await handle?.close().catch(() => undefined);
		await unlink(temporaryPath).catch((cleanupError: unknown) => {
			if (!isMissing(cleanupError)) throw cleanupError;
		});
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
	return temporaryPath;
}

export async function readAndValidateTemporaryFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function removeKnownTemporaryFile(path: string): Promise<void> {
	await unlink(path).catch((error: unknown) => {
		if (!isMissing(error)) throw error;
	});
}

/** Create one private temporary directory in an already-owned directory. */
export async function createOwnedTemporaryDirectory(directory: string, prefix: string): Promise<string> {
	const temporaryPath = join(directory, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
	await mkdir(temporaryPath, { mode: 0o700 });
	await chmod(temporaryPath, 0o700).catch(() => undefined);
	return temporaryPath;
}

/** Remove only a private temporary directory created by this module. */
export async function removeKnownTemporaryDirectory(path: string): Promise<void> {
	if (!/^\.[A-Za-z0-9._-]+\.tmp$/.test(basename(path))) throw new Error(`Refusing to remove an unknown temporary directory: ${path}`);
	await rm(path, { recursive: true, force: true });
}

export async function syncFile(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		await handle.sync();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
		await handle.sync();
	} catch (error: unknown) {
		if (!(["EINVAL", "ENOTSUP", "EBADF", "EISDIR"] as const).includes(errorCode(error) as never)) throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function replaceOwnedFile(path: string, temporaryPath: string): Promise<void> {
	await rename(temporaryPath, path);
	await syncDirectory(dirname(path));
}

export function filesystemErrorText(error: unknown): string {
	return errorText(error);
}
