"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unload = exports.load = exports.methods = void 0;

const child_process_1 = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXTENSION_NAME = 'playableadssetting';
const PANEL_NAME = `${EXTENSION_NAME}.default`;
const PANEL_NAME_CANDIDATES = [
	PANEL_NAME,
	'playableadssetting.default',
	'playable-ads-setting.default',
	'blank-template.default',
];
const OUTPUT_DIR_DEFAULT = 'dist-playable';
const USE_BASE64_DEFAULT = true;
const OUTPUT_DIR_SETTINGS_FILE = path.join('settings', 'v2', 'packages', 'playable-ads-setting.json');

function normalizeOutputDir(input) {
	const v = String(input ?? '').trim();
	return v || OUTPUT_DIR_DEFAULT;
}

function normalizeUseBase64(input) {
	if (typeof input === 'boolean') return input;
	const v = String(input ?? '').trim().toLowerCase();
	if (!v) return USE_BASE64_DEFAULT;
	if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
	return true;
}

function resolveOutputDirAbsolute(projectPath, outputDir) {
	return path.isAbsolute(outputDir) ? outputDir : path.join(projectPath, outputDir);
}

function getOutputSettingsPath(projectPath) {
	return path.join(projectPath, OUTPUT_DIR_SETTINGS_FILE);
}

function loadBuildConfig(projectPath) {
	const settingsPath = getOutputSettingsPath(projectPath);
	const defaults = {
		outputDir: OUTPUT_DIR_DEFAULT,
		useBase64: USE_BASE64_DEFAULT,
	};
	try {
		if (!fs.existsSync(settingsPath)) return defaults;
		const raw = fs.readFileSync(settingsPath, 'utf8');
		const json = JSON.parse(raw);
		return {
			outputDir: normalizeOutputDir(json.outputDir),
			useBase64: normalizeUseBase64(json.useBase64),
		};
	} catch {
		return defaults;
	}
}

function saveBuildConfig(projectPath, patch) {
	const current = loadBuildConfig(projectPath);
	const next = {
		outputDir: normalizeOutputDir(patch.outputDir ?? current.outputDir),
		useBase64: normalizeUseBase64(patch.useBase64 ?? current.useBase64),
	};
	const settingsPath = getOutputSettingsPath(projectPath);
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
	return next;
}

function loadOutputDirSetting(projectPath) {
	return loadBuildConfig(projectPath).outputDir;
}

function saveOutputDirSetting(projectPath, outputDir) {
	return saveBuildConfig(projectPath, { outputDir }).outputDir;
}

function loadUseBase64Setting(projectPath) {
	return loadBuildConfig(projectPath).useBase64;
}

function saveUseBase64Setting(projectPath, useBase64) {
	return saveBuildConfig(projectPath, { useBase64: normalizeUseBase64(useBase64) }).useBase64;
}

function openDirectoryInOS(absDir) {
	return new Promise((resolve) => {
		const platform = process.platform;
		const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
		const child = (0, child_process_1.spawn)(cmd, [absDir], { shell: false, detached: true, stdio: 'ignore' });
		child.on('error', () => resolve(false));
		child.on('spawn', () => {
			child.unref();
			resolve(true);
		});
	});
}
const dynamicImport = new Function('u', 'return import(u);');

async function runPackInProcess(projectPath, scriptPath, normalizedOutputDir, useBase64, outputDirAbs) {
	const oldCwd = process.cwd();
	try {
		process.chdir(projectPath);
		const moduleUrl = `${pathToFileURL(scriptPath).href}?t=${Date.now()}`;
		const mod = await dynamicImport(moduleUrl);

		if (!mod || typeof mod.packSingleHtml !== 'function') {
			throw new Error('pack-single-html.mjs does not export packSingleHtml().');
		}

		const result = await mod.packSingleHtml({ outDir: normalizedOutputDir, useBase64 });
		const files = Array.isArray(result?.files) ? result.files : [];

		return {
			ok: true,
			code: 0,
			stdout: files.length ? `written ${files.length} files` : 'pack completed',
			stderr: '',
			outputDir: outputDirAbs,
			useBase64,
		};
	} catch (err) {
		return {
			ok: false,
			code: null,
			stdout: '',
			stderr: String(err),
			outputDir: outputDirAbs,
			useBase64,
		};
	} finally {
		process.chdir(oldCwd);
	}
}

async function runPlayableBuild(outputDir, useBase64) {
	const projectPath = Editor.Project.path;
	const normalizedOutputDir = normalizeOutputDir(outputDir);
	const outputDirAbs = resolveOutputDirAbsolute(projectPath, normalizedOutputDir);
	const scriptPath = path.join(projectPath, 'tools', 'playable', 'pack-single-html.mjs');
	return runPackInProcess(projectPath, scriptPath, normalizedOutputDir, useBase64, outputDirAbs);
}

exports.methods = {
	async openPanel() {
		let lastErr = null;
		for (const panelName of PANEL_NAME_CANDIDATES) {
			try {
				await Editor.Panel.open(panelName);
				return;
			} catch (err) {
				lastErr = err;
			}
		}
		throw lastErr || new Error(`Panel open failed: ${PANEL_NAME_CANDIDATES.join(', ')}`);
	},
	async buildPlayable(outputDir, useBase64) {
		const projectPath = Editor.Project.path;
		const current = loadBuildConfig(projectPath);
		const next = saveBuildConfig(projectPath, {
			outputDir: outputDir ? normalizeOutputDir(outputDir) : current.outputDir,
			useBase64: useBase64 ?? current.useBase64,
		});
		const result = await runPlayableBuild(next.outputDir, next.useBase64);
		if (result.stdout) {
			console.log(`[PlayableAdsSetting] ${result.stdout}`);
		}
		if (result.stderr) {
			console.error(`[PlayableAdsSetting] ${result.stderr}`);
		}
		return result;
	},
	async getOutputDir() {
		const projectPath = Editor.Project.path;
		return loadOutputDirSetting(projectPath);
	},
	async setOutputDir(outputDir) {
		const projectPath = Editor.Project.path;
		return saveOutputDirSetting(projectPath, normalizeOutputDir(outputDir));
	},
	async getUseBase64() {
		const projectPath = Editor.Project.path;
		return loadUseBase64Setting(projectPath);
	},
	async setUseBase64(useBase64) {
		const projectPath = Editor.Project.path;
		return saveUseBase64Setting(projectPath, useBase64);
	},
	async getBuildConfig() {
		const projectPath = Editor.Project.path;
		return loadBuildConfig(projectPath);
	},
	async setBuildConfig(config) {
		const projectPath = Editor.Project.path;
		return saveBuildConfig(projectPath, config || {});
	},
	async openOutputDir(outputDir) {
		const projectPath = Editor.Project.path;
		const dir = outputDir ? normalizeOutputDir(outputDir) : loadOutputDirSetting(projectPath);
		saveOutputDirSetting(projectPath, dir);
		const absDir = resolveOutputDirAbsolute(projectPath, dir);
		fs.mkdirSync(absDir, { recursive: true });
		const ok = await openDirectoryInOS(absDir);
		return { ok, outputDir: absDir };
	},
};

function load() { }
exports.load = load;

function unload() { }
exports.unload = unload;