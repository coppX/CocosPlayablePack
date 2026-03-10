import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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
const BLOB_COMPRESSION_DEFAULT = 'none';
const OUTPUT_DIR_SETTINGS_FILE = path.join('settings', 'v2', 'packages', 'playable-ads-setting.json');

type BlobCompression = 'none' | 'gzip';

type BuildConfig = {
    outputDir: string;
    useBase64: boolean;
    blobCompression: BlobCompression;
};

type BuildResult = {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    outputDir: string;
    useBase64?: boolean;
    blobCompression?: BlobCompression;
};

function normalizeOutputDir(input: unknown): string {
    const v = String(input ?? '').trim();
    return v || OUTPUT_DIR_DEFAULT;
}

function normalizeUseBase64(input: unknown): boolean {
    if (typeof input === 'boolean') return input;
    const v = String(input ?? '').trim().toLowerCase();
    if (!v) return USE_BASE64_DEFAULT;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return true;
}

function normalizeBlobCompression(input: unknown): BlobCompression {
    const v = String(input ?? '').trim().toLowerCase();
    if (!v) return BLOB_COMPRESSION_DEFAULT;
    if (v === 'gzip' || v === '1' || v === 'true' || v === 'yes' || v === 'on') {
        return 'gzip';
    }
    return 'none';
}

function resolveOutputDirAbsolute(projectPath: string, outputDir: string): string {
    return path.isAbsolute(outputDir) ? outputDir : path.join(projectPath, outputDir);
}

function getOutputSettingsPath(projectPath: string): string {
    return path.join(projectPath, OUTPUT_DIR_SETTINGS_FILE);
}

function loadBuildConfig(projectPath: string): BuildConfig {
    const settingsPath = getOutputSettingsPath(projectPath);
    const defaults: BuildConfig = {
        outputDir: OUTPUT_DIR_DEFAULT,
        useBase64: USE_BASE64_DEFAULT,
        blobCompression: BLOB_COMPRESSION_DEFAULT,
    };

    try {
        if (!fs.existsSync(settingsPath)) return defaults;
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const json = JSON.parse(raw) as { outputDir?: string; useBase64?: boolean; blobCompression?: string };
        return {
            outputDir: normalizeOutputDir(json.outputDir),
            useBase64: normalizeUseBase64(json.useBase64),
            blobCompression: normalizeBlobCompression(json.blobCompression),
        };
    } catch {
        return defaults;
    }
}

function saveBuildConfig(projectPath: string, patch: Partial<BuildConfig>): BuildConfig {
    const current = loadBuildConfig(projectPath);
    const next: BuildConfig = {
        outputDir: normalizeOutputDir(patch.outputDir ?? current.outputDir),
        useBase64: normalizeUseBase64(patch.useBase64 ?? current.useBase64),
        blobCompression: normalizeBlobCompression(patch.blobCompression ?? current.blobCompression),
    };

    const settingsPath = getOutputSettingsPath(projectPath);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function loadOutputDirSetting(projectPath: string): string {
    return loadBuildConfig(projectPath).outputDir;
}

function saveOutputDirSetting(projectPath: string, outputDir: string): string {
    return saveBuildConfig(projectPath, { outputDir }).outputDir;
}

function loadUseBase64Setting(projectPath: string): boolean {
    return loadBuildConfig(projectPath).useBase64;
}

function saveUseBase64Setting(projectPath: string, useBase64: unknown): boolean {
    return saveBuildConfig(projectPath, { useBase64: normalizeUseBase64(useBase64) }).useBase64;
}

function loadBlobCompressionSetting(projectPath: string): BlobCompression {
    return loadBuildConfig(projectPath).blobCompression;
}

function saveBlobCompressionSetting(projectPath: string, blobCompression: unknown): BlobCompression {
    return saveBuildConfig(projectPath, { blobCompression: normalizeBlobCompression(blobCompression) }).blobCompression;
}

function openDirectoryInOS(absDir: string): Promise<boolean> {
    return new Promise((resolve) => {
        const platform = process.platform;
        const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(cmd, [absDir], { shell: false, detached: true, stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('spawn', () => {
            child.unref();
            resolve(true);
        });
    });
}

const dynamicImport = new Function('u', 'return import(u);') as (u: string) => Promise<any>;

async function runPackInProcess(projectPath: string, scriptPath: string, normalizedOutputDir: string, useBase64: boolean, blobCompression: BlobCompression, outputDirAbs: string): Promise<BuildResult> {
    const oldCwd = process.cwd();
    try {
        process.chdir(projectPath);
        const moduleUrl = `${pathToFileURL(scriptPath).href}?t=${Date.now()}`;
        const mod = await dynamicImport(moduleUrl) as { packSingleHtml?: (options?: { outDir?: string; useBase64?: boolean; blobCompression?: BlobCompression; compressImages?: boolean; imageQuality?: number }) => Promise<{ files?: string[] } | { files?: string[] }> | { files?: string[] } };

        if (typeof mod.packSingleHtml !== 'function') {
            throw new Error('pack-single-html.mjs does not export packSingleHtml().');
        }

        const result = await mod.packSingleHtml({ outDir: normalizedOutputDir, useBase64, blobCompression });
        const files = Array.isArray(result?.files) ? result.files : [];

        return {
            ok: true,
            code: 0,
            stdout: files.length ? `written ${files.length} files` : 'pack completed',
            stderr: '',
            outputDir: outputDirAbs,
            useBase64,
            blobCompression,
        };
    } catch (err) {
        return {
            ok: false,
            code: null,
            stdout: '',
            stderr: String(err),
            outputDir: outputDirAbs,
            useBase64,
            blobCompression,
        };
    } finally {
        process.chdir(oldCwd);
    }
}

async function runPlayableBuild(outputDir: string, useBase64: boolean, blobCompression: BlobCompression): Promise<BuildResult> {
    const projectPath = Editor.Project.path;
    const normalizedOutputDir = normalizeOutputDir(outputDir);
    const outputDirAbs = resolveOutputDirAbsolute(projectPath, normalizedOutputDir);
    const scriptPath = path.join(projectPath, 'tools', 'playable', 'pack-single-html.mjs');
    return runPackInProcess(projectPath, scriptPath, normalizedOutputDir, useBase64, blobCompression, outputDirAbs);
}

/**
 * @en Registration method for the main process of Extension
 * @zh 为扩展的主进程的注册方法
 */
export const methods: { [key: string]: (...any: any) => any } = {
    async openPanel() {
        let lastErr: unknown = null;
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

    async buildPlayable(outputDir?: string, useBase64?: boolean, blobCompression?: string) {
        const projectPath = Editor.Project.path;
        const current = loadBuildConfig(projectPath);
        const next = saveBuildConfig(projectPath, {
            outputDir: outputDir ? normalizeOutputDir(outputDir) : current.outputDir,
            useBase64: useBase64 ?? current.useBase64,
            blobCompression: blobCompression === undefined ? current.blobCompression : normalizeBlobCompression(blobCompression),
        });
        const result = await runPlayableBuild(next.outputDir, next.useBase64, next.blobCompression);
        if (result.stdout) console.log(`[PlayableAdsSetting] ${result.stdout}`);
        if (result.stderr) console.error(`[PlayableAdsSetting] ${result.stderr}`);
        return result;
    },

    async getOutputDir() {
        const projectPath = Editor.Project.path;
        return loadOutputDirSetting(projectPath);
    },

    async setOutputDir(outputDir?: string) {
        const projectPath = Editor.Project.path;
        return saveOutputDirSetting(projectPath, normalizeOutputDir(outputDir));
    },

    async getUseBase64() {
        const projectPath = Editor.Project.path;
        return loadUseBase64Setting(projectPath);
    },

    async setUseBase64(useBase64?: boolean) {
        const projectPath = Editor.Project.path;
        return saveUseBase64Setting(projectPath, useBase64);
    },

    async getBlobCompression() {
        const projectPath = Editor.Project.path;
        return loadBlobCompressionSetting(projectPath);
    },

    async setBlobCompression(blobCompression?: string) {
        const projectPath = Editor.Project.path;
        return saveBlobCompressionSetting(projectPath, blobCompression);
    },

    async getBuildConfig() {
        const projectPath = Editor.Project.path;
        return loadBuildConfig(projectPath);
    },

    async setBuildConfig(config?: Partial<BuildConfig>) {
        const projectPath = Editor.Project.path;
        return saveBuildConfig(projectPath, config || {});
    },

    async openOutputDir(outputDir?: string) {
        const projectPath = Editor.Project.path;
        const dir = outputDir ? normalizeOutputDir(outputDir) : loadOutputDirSetting(projectPath);
        saveOutputDirSetting(projectPath, dir);
        const absDir = resolveOutputDirAbsolute(projectPath, dir);
        fs.mkdirSync(absDir, { recursive: true });
        const ok = await openDirectoryInOS(absDir);
        return { ok, outputDir: absDir };
    },
};

/**
 * @en Method Triggered on Extension Startup
 * @zh 扩展启动时触发的方法
 */
export function load() {}

/**
 * @en Method triggered when uninstalling the extension
 * @zh 卸载扩展时触发的方法
 */
export function unload() {}
