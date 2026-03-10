type BuildResult = {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    outputDir?: string;
    useBase64?: boolean;
    blobCompression?: BlobCompression;
};

type BlobCompression = 'none' | 'gzip';

type BuildConfig = {
    outputDir: string;
    useBase64: boolean;
    blobCompression: BlobCompression;
};

const extensionName = 'playableadssetting';
const extensionNameCandidates = [
    extensionName,
    'playableadssetting',
    'playable-ads-setting',
    'blank-template',
];

async function requestMain<T = unknown>(message: string, ...args: unknown[]): Promise<T> {
    let lastErr: unknown = null;
    for (const name of extensionNameCandidates) {
        try {
            return await (Editor.Message.request as any)(name, message, ...args) as T;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error(`Message request failed: ${message}`);
}

type OpenOutputDirResult = {
    ok: boolean;
    outputDir: string;
};

module.exports = Editor.Panel.define({
    template: `
<div class="playable-ads-setting">
    <div class="title">Playable HTML Builder</div>
    <div class="field-group">
        <div class="field-label">Output Directory</div>
        <ui-input id="outDirInput" class="dir-input"></ui-input>
        <ui-checkbox id="useBase64Toggle" class="base64-toggle">Use Base64 For Assets</ui-checkbox>
        <div class="field-label">Blob Compression</div>
        <ui-select id="blobCompressionSelect" class="compression-select">
            <option value="none">None</option>
            <option value="gzip">Gzip</option>
        </ui-select>
        <ui-button id="saveSettingBtn" class="save-btn">Save Setting</ui-button>
    </div>
    <div class="button-row">
        <ui-button id="buildBtn" class="build-btn">Build</ui-button>
        <ui-button id="openOutputBtn" class="open-btn">Open Output Folder</ui-button>
    </div>
    <div id="status" class="status">Ready</div>
</div>
`,
    style: `
.playable-ads-setting {
    box-sizing: border-box;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.title {
    font-size: 13px;
    font-weight: 700;
}

.field-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.field-label {
    font-size: 12px;
    opacity: 0.85;
}

.dir-input {
    width: 100%;
}

.base64-toggle {
    margin-top: 2px;
}

.compression-select {
    width: 100%;
}

.button-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.build-btn {
    width: 120px;
}

.open-btn {
    width: 160px;
}

.save-btn {
    width: 120px;
}

.status {
    min-height: 18px;
    color: var(--color-normal-fill);
    white-space: pre-wrap;
    word-break: break-word;
}

.status.success {
    color: #2aa545;
}

.status.error {
    color: #d44;
}
`,

    $: {
        buildBtn: '#buildBtn',
        openOutputBtn: '#openOutputBtn',
        saveSettingBtn: '#saveSettingBtn',
        outDirInput: '#outDirInput',
        useBase64Toggle: '#useBase64Toggle',
        blobCompressionSelect: '#blobCompressionSelect',
        status: '#status',
    },

    methods: {
        getOutputDir(this: any) {
            const input = this.$.outDirInput as HTMLInputElement | null;
            return String(input?.value ?? '').trim() || 'dist-playable';
        },

        getUseBase64(this: any) {
            const toggle = this.$.useBase64Toggle as any;
            if (!toggle) return true;
            if (typeof toggle.value === 'boolean') return toggle.value;
            if (typeof toggle.checked === 'boolean') return toggle.checked;
            const attr = String(toggle.getAttribute?.('value') ?? '').toLowerCase();
            if (!attr) return true;
            return !(attr === 'false' || attr === '0' || attr === 'off' || attr === 'no');
        },

        setUseBase64(this: any, useBase64: boolean) {
            const toggle = this.$.useBase64Toggle as any;
            if (!toggle) return;
            const v = !!useBase64;
            try { toggle.value = v; } catch {}
            try { toggle.checked = v; } catch {}
            try { toggle.setAttribute?.('value', v ? 'true' : 'false'); } catch {}
            try {
                if (v) toggle.setAttribute?.('checked', '');
                else toggle.removeAttribute?.('checked');
            } catch {}
        },

        normalizeBlobCompression(this: any, value: unknown): BlobCompression {
            const v = String(value ?? '').trim().toLowerCase();
            return v === 'gzip' ? 'gzip' : 'none';
        },

        getBlobCompression(this: any): BlobCompression {
            const select = this.$.blobCompressionSelect as any;
            if (!select) return 'none';
            return this.normalizeBlobCompression(select.value);
        },

        setBlobCompression(this: any, blobCompression: unknown) {
            const select = this.$.blobCompressionSelect as any;
            if (!select) return;
            const v = this.normalizeBlobCompression(blobCompression);
            try { select.value = v; } catch {}
            try { select.setAttribute?.('value', v); } catch {}
        },

        async loadBuildConfig(this: any) {
            const input = this.$.outDirInput as HTMLInputElement | null;
            if (!input) return;
            try {
                const config = await requestMain<BuildConfig>('get-build-config');
                input.value = String(config?.outputDir || 'dist-playable');
                this.setUseBase64(config?.useBase64 ?? true);
                this.setBlobCompression(config?.blobCompression ?? 'none');
            } catch {
                input.value = 'dist-playable';
                this.setUseBase64(true);
                this.setBlobCompression('none');
            }
        },

        setStatus(this: any, text: string, type: 'normal' | 'success' | 'error' = 'normal') {
            const status = this.$.status as HTMLElement | null;
            if (!status) return;
            status.textContent = text;
            status.classList.remove('success', 'error');
            if (type === 'success') status.classList.add('success');
            if (type === 'error') status.classList.add('error');
        },

        async onSaveSetting(this: any) {
            const outputDir = this.getOutputDir();
            const useBase64 = this.getUseBase64();
            const blobCompression = this.getBlobCompression();
            try {
                const saved = await requestMain<BuildConfig>('set-build-config', { outputDir, useBase64, blobCompression });
                const input = this.$.outDirInput as HTMLInputElement | null;
                if (input) input.value = saved.outputDir;
                this.setUseBase64(saved.useBase64);
                this.setBlobCompression(saved.blobCompression);
                this.setStatus(`Setting saved: ${saved.outputDir} | base64=${saved.useBase64 ? 'on' : 'off'} | compression=${saved.blobCompression}`, 'success');
            } catch (err) {
                this.setStatus(`Save failed: ${String(err)}`, 'error');
            }
        },

        async onOpenOutputDir(this: any) {
            const outputDir = this.getOutputDir();
            try {
                const result = await requestMain<OpenOutputDirResult>('open-output-dir', outputDir);
                if (result?.ok) {
                    this.setStatus(`Opened: ${result.outputDir}`, 'success');
                } else {
                    this.setStatus('Open folder failed.', 'error');
                }
            } catch (err) {
                this.setStatus(`Open folder failed: ${String(err)}`, 'error');
            }
        },

        async onBuild(this: any) {
            const outputDir = this.getOutputDir();
            const useBase64 = this.getUseBase64();
            const blobCompression = this.getBlobCompression();
            const buildBtn = this.$.buildBtn as HTMLButtonElement | null;
            if (buildBtn) buildBtn.disabled = true;
            this.setStatus('Building...', 'normal');

            try {
                await requestMain('set-build-config', { outputDir, useBase64, blobCompression });
                const result = await requestMain<BuildResult>('build-playable', outputDir, useBase64, blobCompression);
                if (result?.ok) {
                    this.setStatus(`Build complete. Output: ${result.outputDir || outputDir} | base64=${result.useBase64 ? 'on' : 'off'} | compression=${result.blobCompression || blobCompression}`, 'success');
                } else {
                    const err = result?.stderr || result?.stdout || `Exit code: ${result?.code ?? 'unknown'}`;
                    this.setStatus(`Build failed: ${err}`, 'error');
                }
            } catch (err) {
                this.setStatus(`Build failed: ${String(err)}`, 'error');
            } finally {
                if (buildBtn) buildBtn.disabled = false;
            }
        },
    },

    ready(this: any) {
        const buildBtn = this.$.buildBtn as HTMLElement | null;
        const openOutputBtn = this.$.openOutputBtn as HTMLElement | null;
        const saveSettingBtn = this.$.saveSettingBtn as HTMLElement | null;
        if (!buildBtn || !openOutputBtn || !saveSettingBtn) return;
        this.loadBuildConfig();
        this.__onBuildHandler__ = this.onBuild.bind(this);
        this.__onOpenOutputDirHandler__ = this.onOpenOutputDir.bind(this);
        this.__onSaveSettingHandler__ = this.onSaveSetting.bind(this);
        buildBtn.addEventListener('confirm', this.__onBuildHandler__);
        openOutputBtn.addEventListener('confirm', this.__onOpenOutputDirHandler__);
        saveSettingBtn.addEventListener('confirm', this.__onSaveSettingHandler__);
    },

    close(this: any) {
        const buildBtn = this.$.buildBtn as HTMLElement | null;
        const openOutputBtn = this.$.openOutputBtn as HTMLElement | null;
        const saveSettingBtn = this.$.saveSettingBtn as HTMLElement | null;
        const h = this.__onBuildHandler__;
        const openH = this.__onOpenOutputDirHandler__;
        const saveH = this.__onSaveSettingHandler__;
        if (!buildBtn || !openOutputBtn || !saveSettingBtn || !h || !openH || !saveH) return;
        buildBtn.removeEventListener('confirm', h);
        openOutputBtn.removeEventListener('confirm', openH);
        saveSettingBtn.removeEventListener('confirm', saveH);
    },
});
