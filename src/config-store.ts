import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import {
	decodeProjectModelPlansDocument,
	decodeRecoveryDocument,
	serializeModelPlans,
	serializeRecoveryDefaults,
	validateProjectModelPlans,
	validateRecoveryDefaults,
	type ConfigDiagnostic,
	type ProjectModelPlans,
	type RecoveryDefaults,
	createBuiltinRecoveryDocument,
} from "./config.ts";
import { ensureProjectStateDirectory, resolveProjectStatePaths } from "./project-state.ts";

const STEWARD_DIRECTORY_NAME = "steward";
const DEFAULTS_FILE_NAME = "defaults.json";

export interface ConfigStoreOptions {
	agentDir?: string;
	configDirName?: string;
}

export interface ConfigLoadResult<T> {
	kind: "loaded" | "missing" | "error";
	path: string;
	value: T | undefined;
	diagnostics: ConfigDiagnostic[];
}

export interface ConfigSaveResult {
	kind: "saved" | "error";
	path: string;
	diagnostics: ConfigDiagnostic[];
}

export interface ConfigStore {
	loadRecoveryDefaults(): Promise<ConfigLoadResult<RecoveryDefaults>>;
	loadModelPlans(repositoryRoot: string): Promise<ConfigLoadResult<ProjectModelPlans>>;
	saveRecoveryDefaults(recovery: RecoveryDefaults): Promise<ConfigSaveResult>;
	saveModelPlans(repositoryRoot: string, modelPlans: ProjectModelPlans): Promise<ConfigSaveResult>;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0 ? error.message : "Unknown filesystem error.";
}

function userDefaultsPath(agentDir: string): string {
	return join(agentDir, STEWARD_DIRECTORY_NAME, DEFAULTS_FILE_NAME);
}

function projectDefaultsPath(repositoryRoot: string, configDirName: string): string {
	return join(repositoryRoot, configDirName, STEWARD_DIRECTORY_NAME, DEFAULTS_FILE_NAME);
}

function projectStewardDirectory(repositoryRoot: string, configDirName: string): string {
	return resolveProjectStatePaths(repositoryRoot, configDirName).stewardDirectory;
}

async function readJson(path: string): Promise<
	| { kind: "missing" }
	| { kind: "read-error"; error: unknown }
	| { kind: "invalid-json"; error: unknown }
	| { kind: "json"; value: unknown }
> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error: unknown) {
		return isMissingPath(error) ? { kind: "missing" } : { kind: "read-error", error };
	}

	try {
		return { kind: "json", value: JSON.parse(content) as unknown };
	} catch (error: unknown) {
		return { kind: "invalid-json", error: new Error(`Malformed JSON: ${errorText(error)}`) };
	}
}

async function writeAtomically(path: string, content: string): Promise<void> {
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${DEFAULTS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
	} catch (error: unknown) {
		if (handle) await handle.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

function loadError<T>(path: string, message: string): ConfigLoadResult<T> {
	return {
		kind: "error",
		path,
		value: undefined,
		diagnostics: [{ code: "load-error", message, path }],
	};
}

function invalidConfig<T>(path: string, message: string): ConfigLoadResult<T> {
	return {
		kind: "error",
		path,
		value: undefined,
		diagnostics: [{ code: "invalid-config", message, path }],
	};
}

export function resolveRecoveryDefaultsPath(agentDir = getAgentDir()): string {
	return userDefaultsPath(agentDir);
}

export function resolveProjectModelPlansPath(repositoryRoot: string, configDirName = CONFIG_DIR_NAME): string {
	return projectDefaultsPath(repositoryRoot, configDirName);
}

export function createConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
	const agentDir = options.agentDir ?? getAgentDir();
	const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
	const recoveryPath = userDefaultsPath(agentDir);

	async function loadRecoveryDefaults(): Promise<ConfigLoadResult<RecoveryDefaults>> {
		const result = await readJson(recoveryPath);
		if (result.kind === "missing") {
			return { kind: "missing", path: recoveryPath, value: createBuiltinRecoveryDocument().recovery, diagnostics: [] };
		}
		if (result.kind === "read-error") return loadError(recoveryPath, `${recoveryPath}: ${errorText(result.error)}`);
		if (result.kind === "invalid-json") return invalidConfig(recoveryPath, `${recoveryPath}: ${errorText(result.error)}`);

		const decoded = decodeRecoveryDocument(result.value, recoveryPath);
		return decoded.value
			? { kind: "loaded", path: recoveryPath, value: decoded.value.recovery, diagnostics: [] }
			: { kind: "error", path: recoveryPath, value: undefined, diagnostics: decoded.diagnostics };
	}

	async function loadModelPlans(repositoryRoot: string): Promise<ConfigLoadResult<ProjectModelPlans>> {
		const path = projectDefaultsPath(repositoryRoot, configDirName);
		const result = await readJson(path);
		if (result.kind === "missing") return { kind: "missing", path, value: undefined, diagnostics: [] };
		if (result.kind === "read-error") return loadError(path, `${path}: ${errorText(result.error)}`);
		if (result.kind === "invalid-json") return invalidConfig(path, `${path}: ${errorText(result.error)}`);

		const decoded = decodeProjectModelPlansDocument(result.value, path);
		return decoded.value
			? { kind: "loaded", path, value: decoded.value.modelPlans, diagnostics: [] }
			: { kind: "error", path, value: undefined, diagnostics: decoded.diagnostics };
	}

	async function saveRecoveryDefaults(recovery: RecoveryDefaults): Promise<ConfigSaveResult> {
		const validation = validateRecoveryDefaults(recovery, recoveryPath);
		if (!validation.value || validation.diagnostics.length > 0) {
			return { kind: "error", path: recoveryPath, diagnostics: validation.diagnostics };
		}
		try {
			await mkdir(dirname(recoveryPath), { recursive: true, mode: 0o700 });
			await chmod(dirname(recoveryPath), 0o700).catch(() => undefined);
			await writeAtomically(recoveryPath, serializeRecoveryDefaults(validation.value));
			return { kind: "saved", path: recoveryPath, diagnostics: [] };
		} catch (error: unknown) {
			return {
				kind: "error",
				path: recoveryPath,
				diagnostics: [{ code: "save-error", message: `${recoveryPath}: ${errorText(error)}`, path: recoveryPath }],
			};
		}
	}

	async function saveModelPlans(repositoryRoot: string, modelPlans: ProjectModelPlans): Promise<ConfigSaveResult> {
		const directory = projectStewardDirectory(repositoryRoot, configDirName);
		const path = projectDefaultsPath(repositoryRoot, configDirName);
		const validation = validateProjectModelPlans(modelPlans, path);
		if (!validation.value || validation.diagnostics.length > 0) {
			return { kind: "error", path, diagnostics: validation.diagnostics };
		}
		try {
			await ensureProjectStateDirectory(repositoryRoot, configDirName);
			await writeAtomically(path, serializeModelPlans(validation.value));
			return { kind: "saved", path, diagnostics: [] };
		} catch (error: unknown) {
			return {
				kind: "error",
				path,
				diagnostics: [{ code: "save-error", message: `${path}: ${errorText(error)}`, path }],
			};
		}
	}

	return { loadRecoveryDefaults, loadModelPlans, saveRecoveryDefaults, saveModelPlans };
}
