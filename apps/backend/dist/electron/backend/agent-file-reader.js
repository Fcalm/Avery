"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentFileReader = exports.LocalTesseractOcrEngine = exports.OCR_CACHE_VERSION = void 0;
exports.DetectImageMime = DetectImageMime;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const OCR_OUTPUT_LIMIT = 5000;
exports.OCR_CACHE_VERSION = 'tesseract-7.0.0-chi_sim+eng-v1';
const MAX_OCR_CACHE_BYTES = 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
});
/** 仅依据文件头识别 V1 允许的图片类型，避免扩展名伪装进入解码器。 */
function DetectImageMime(buffer) {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return 'image/jpeg';
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
        return 'image/webp';
    return null;
}
function ValidationError(message) {
    return Object.assign(new Error(message), { code: 'VALIDATION_ERROR' });
}
/** Tesseract.js 的离线执行器：语言数据从随包 npm 依赖复制到 userData，绝不回退到 CDN。 */
class LocalTesseractOcrEngine {
    runtimeRoot;
    workerPromise = null;
    queue = Promise.resolve();
    constructor(runtimeRoot) {
        this.runtimeRoot = runtimeRoot;
    }
    PrepareLanguageData() {
        const languagePath = path.join(this.runtimeRoot, 'languages');
        const cachePath = path.join(this.runtimeRoot, 'cache');
        (0, node_fs_1.mkdirSync)(languagePath, { recursive: true });
        (0, node_fs_1.mkdirSync)(cachePath, { recursive: true });
        for (const packageName of ['@tesseract.js-data/eng', '@tesseract.js-data/chi_sim']) {
            const language = require(packageName);
            const source = path.join(language.langPath, `${language.code}.traineddata.gz`);
            const destination = path.join(languagePath, `${language.code}.traineddata.gz`);
            const sourceBuffer = (0, node_fs_1.readFileSync)(source);
            const sourceHash = (0, node_crypto_1.createHash)('sha256').update(sourceBuffer).digest('hex');
            const destinationHash = (0, node_fs_1.existsSync)(destination) ? (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(destination)).digest('hex') : null;
            if (destinationHash !== sourceHash) {
                const temporary = `${destination}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
                (0, node_fs_1.writeFileSync)(temporary, sourceBuffer, { flag: 'wx' });
                if ((0, node_fs_1.existsSync)(destination))
                    (0, node_fs_1.rmSync)(destination, { force: true });
                renameSyncSafe(temporary, destination);
            }
        }
        return { languagePath, cachePath };
    }
    async GetWorker() {
        if (!this.workerPromise) {
            this.workerPromise = (async () => {
                const { createWorker, OEM } = require('tesseract.js');
                const { languagePath, cachePath } = this.PrepareLanguageData();
                return createWorker('chi_sim+eng', OEM.LSTM_ONLY, {
                    langPath: languagePath,
                    cachePath,
                    cacheMethod: 'write',
                    gzip: true,
                    logger: () => undefined,
                });
            })().catch((error) => {
                this.workerPromise = null;
                throw error;
            });
        }
        return this.workerPromise;
    }
    async Recognize(image) {
        const execute = async () => {
            const worker = await this.GetWorker();
            const result = await worker.recognize(image, {}, { text: true, blocks: true });
            const data = result?.data ?? {};
            const regions = Array.isArray(data.blocks) ? data.blocks.slice(0, 20).map((block) => ({
                text: String(block.text ?? '').trim().slice(0, 500),
                confidence: Number.isFinite(block.confidence) ? block.confidence : null,
                bbox: block.bbox ? { x0: block.bbox.x0, y0: block.bbox.y0, x1: block.bbox.x1, y1: block.bbox.y1 } : null,
            })).filter((region) => region.text) : [];
            return { text: String(data.text ?? ''), confidence: Number(data.confidence ?? 0), regions };
        };
        const result = this.queue.then(execute, execute);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
    async Close() {
        await this.queue.catch(() => undefined);
        const worker = this.workerPromise ? await this.workerPromise.catch(() => null) : null;
        this.workerPromise = null;
        if (worker)
            await worker.terminate();
    }
}
exports.LocalTesseractOcrEngine = LocalTesseractOcrEngine;
function renameSyncSafe(from, to) {
    (0, node_fs_1.renameSync)(from, to);
}
/**
 * 宿主侧文件读取端口（FileReadPort 注入默认 tools 模块）：
 * 承载 pdf/docx/txt 解析、物理路径校验与资源边界；默认模块不持有任何 Node 解析能力。
 * 注意：pdf-parse/mammoth 仅在解析方法首次调用时 require——该时机必然晚于 apps/backend/dist/index.js 的
 * InstallBrowserPolyfills()（启动即注入），因此首用加载不会破坏 pdf-parse 的浏览器全局依赖。
 */
class AgentFileReader {
    _resolveAttachment;
    _authorizedMetadata = new Map();
    ocrCacheRoot;
    ocrEngine;
    constructor(ResolveAttachmentUri, options = {}) {
        this._resolveAttachment = ResolveAttachmentUri;
        this.ocrCacheRoot = options.ocrCacheRoot ?? null;
        this.ocrEngine = options.ocrEngine ?? new LocalTesseractOcrEngine(options.ocrRuntimeRoot ?? path.join(process.cwd(), '.offerget-ocr-runtime'));
    }
    SetOcrCacheRoot(cacheRoot) {
        this.ocrCacheRoot = cacheRoot || null;
    }
    /** FileReadPort 接口：将 attachment:// 虚拟 URI 解析为宿主私有物理路径；回调返回字符串或含 physicalPath 的对象，统一归一化；未注册返回 null。 */
    async ResolveAttachmentUri(uri) {
        const resolved = await this._resolveAttachment(uri);
        if (resolved == null)
            return null;
        const physicalPath = typeof resolved === 'string' ? resolved : resolved.physicalPath ?? null;
        if (physicalPath && typeof resolved === 'object') {
            const meta = resolved;
            this._authorizedMetadata.set(physicalPath, { name: typeof meta.name === 'string' ? meta.name : null, mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : null });
            if (this._authorizedMetadata.size > 500)
                this._authorizedMetadata.delete(this._authorizedMetadata.keys().next().value);
        }
        return physicalPath;
    }
    /** 解析项目内请求路径并校验真实路径仍位于会话绑定的项目目录，拒绝符号链接越界。 */
    ResolveProjectPath(projectRoot, requestedPath) {
        if (!projectRoot)
            throw new Error('No project environment is bound to this session.');
        const root = (0, node_fs_1.realpathSync)(projectRoot);
        const candidate = path.resolve(root, requestedPath);
        const relative = path.relative(root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('Unable to access paths outside the project environment.');
        const realPath = (0, node_fs_1.realpathSync)(candidate);
        const realRelative = path.relative(root, realPath);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
            throw new Error('Unable to access paths outside the project environment.');
        return realPath;
    }
    /** 枚举项目环境内的常规文件，跳过依赖缓存、隐藏目录和符号链接，限制扫描规模；返回绝对路径与相对 POSIX 路径。 */
    ListProjectFiles(projectPath, limit = 1000) {
        const files = [];
        const root = (0, node_fs_1.realpathSync)(projectPath);
        const visit = (directory) => {
            if (files.length >= limit)
                return;
            for (const entry of (0, node_fs_1.readdirSync)(directory, { withFileTypes: true })) {
                if (files.length >= limit || entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.'))
                    continue;
                const candidate = path.join(directory, entry.name);
                if (entry.isSymbolicLink())
                    continue;
                if (entry.isDirectory())
                    visit(candidate);
                else if (entry.isFile())
                    files.push({ path: candidate, name: path.relative(root, candidate).replace(/\\/g, '/') });
            }
        };
        visit(root);
        return files;
    }
    /** 将受限 Glob 模式转换为文件名匹配正则，先保护双星号以避免被单星号二次替换。 */
    CreateGlobMatcher(pattern) {
        const placeholder = '__OFFERGET_GLOBSTAR__';
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, placeholder).replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.').replace(new RegExp(placeholder, 'g'), '.*');
        return new RegExp(`^${escaped}$`, 'i');
    }
    /** 读取受限文本内容：所有文件受 5 MB 物理上限及 5,000 字符上下文上限保护。 */
    ReadTextFile(filePath) {
        const stat = (0, node_fs_1.statSync)(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
        const content = (0, node_fs_1.readFileSync)(filePath, 'utf8');
        if (content.includes('\u0000'))
            throw new Error('This file is not a readable text file.');
        return { content: content.slice(0, 5000), truncated: content.length > 5000 };
    }
    /** 提取受限 DOCX 文本；仅读取段落与表格文本，不执行宏、脚本或外部链接。 */
    async ReadDocxFile(filePath) {
        const stat = (0, node_fs_1.statSync)(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        const content = String(result.value ?? '');
        return { content: content.slice(0, 5000), truncated: content.length > 5000, warnings: result.messages.map((message) => message.message).slice(0, 10) };
    }
    /** 提取不超过十页的 PDF 文本；扫描型或无文本层 PDF 会明确返回空文本。 */
    async ReadPdfFile(filePath) {
        const stat = (0, node_fs_1.statSync)(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
            throw new Error('The file is unavailable or exceeds the 5 MB reading limit.');
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: (0, node_fs_1.readFileSync)(filePath) });
        try {
            const info = await parser.getInfo();
            if (info.total > 10)
                throw new Error('PDF files are limited to 10 pages.');
            const result = await parser.getText();
            const content = String(result.text ?? '');
            return { content: content.slice(0, 5000), truncated: content.length > 5000, pages: info.total, needsOcr: content.trim().length === 0 };
        }
        finally {
            await parser.destroy();
        }
    }
    ReadOcrCache(hash) {
        if (!this.ocrCacheRoot)
            return null;
        const cachePath = path.join(this.ocrCacheRoot, `${hash}-${exports.OCR_CACHE_VERSION}.json`);
        try {
            const stat = (0, node_fs_1.statSync)(cachePath);
            if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OCR_CACHE_BYTES)
                return null;
            const cached = JSON.parse((0, node_fs_1.readFileSync)(cachePath, 'utf8'));
            const result = cached?.result;
            const ocr = result?.ocr;
            if (cached?.hash !== hash || cached?.version !== exports.OCR_CACHE_VERSION || typeof result?.content !== 'string' || result.content.length > OCR_OUTPUT_LIMIT
                || typeof result?.truncated !== 'boolean' || !Array.isArray(result?.warnings) || !ocr || typeof ocr?.confidence !== 'number'
                || typeof ocr?.lowConfidence !== 'boolean' || ocr?.version !== exports.OCR_CACHE_VERSION || !ocr?.source || !Array.isArray(ocr.source.regions))
                return null;
            return {
                content: result.content,
                truncated: result.truncated,
                warnings: result.warnings.filter((item) => typeof item === 'string').slice(0, 10).map((item) => item.slice(0, 500)),
                ocr: {
                    engine: 'tesseract.js', version: exports.OCR_CACHE_VERSION, languages: ['chi_sim', 'eng'],
                    confidence: Math.max(0, Math.min(100, ocr.confidence)), lowConfidence: ocr.lowConfidence, cacheHit: true,
                    source: { page: 1, regions: ocr.source.regions.slice(0, 20) },
                },
            };
        }
        catch {
            return null;
        }
    }
    WriteOcrCache(hash, result) {
        if (!this.ocrCacheRoot)
            return;
        (0, node_fs_1.mkdirSync)(this.ocrCacheRoot, { recursive: true });
        const cachePath = path.join(this.ocrCacheRoot, `${hash}-${exports.OCR_CACHE_VERSION}.json`);
        const temporary = `${cachePath}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        (0, node_fs_1.writeFileSync)(temporary, JSON.stringify({ hash, version: exports.OCR_CACHE_VERSION, result }), { encoding: 'utf8', flag: 'wx' });
        try {
            if ((0, node_fs_1.existsSync)(cachePath))
                (0, node_fs_1.rmSync)(cachePath, { force: true });
            renameSyncSafe(temporary, cachePath);
        }
        finally {
            if ((0, node_fs_1.existsSync)(temporary))
                (0, node_fs_1.rmSync)(temporary, { force: true });
        }
    }
    /** 校验扩展名、声明 MIME 与文件魔数，解码归一化后执行完全离线 OCR。 */
    async ReadImageFile(filePath, sourceName = filePath, declaredMimeType = null) {
        const stat = (0, node_fs_1.statSync)(filePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES)
            throw ValidationError('The image is unavailable or exceeds the 5 MB reading limit.');
        const extension = path.extname(sourceName).toLowerCase();
        const expectedMime = IMAGE_TYPES[extension];
        if (!expectedMime)
            throw ValidationError('This image extension is not supported.');
        const image = (0, node_fs_1.readFileSync)(filePath);
        const detectedMime = DetectImageMime(image);
        if (!detectedMime || detectedMime !== expectedMime)
            throw ValidationError('The image content does not match its file extension.');
        if (declaredMimeType && String(declaredMimeType).toLowerCase() !== expectedMime)
            throw ValidationError('The image MIME type does not match its file extension.');
        const hash = (0, node_crypto_1.createHash)('sha256').update(image).digest('hex');
        const cached = this.ReadOcrCache(hash);
        if (cached)
            return cached;
        let normalized;
        try {
            const { createCanvas, loadImage } = require('@napi-rs/canvas');
            const decoded = await loadImage(image);
            const pixels = decoded.width * decoded.height;
            if (!decoded.width || !decoded.height || pixels > MAX_IMAGE_PIXELS)
                throw ValidationError('The image dimensions exceed the local OCR safety limit.');
            const canvas = createCanvas(decoded.width, decoded.height);
            canvas.getContext('2d').drawImage(decoded, 0, 0);
            normalized = canvas.toBuffer('image/png');
        }
        catch (error) {
            if (error?.code === 'VALIDATION_ERROR')
                throw error;
            throw ValidationError('The image cannot be decoded by the local OCR runtime.');
        }
        const recognized = await this.ocrEngine.Recognize(normalized);
        const fullText = String(recognized.text ?? '').trim();
        const confidence = Math.max(0, Math.min(100, Number(recognized.confidence ?? 0)));
        const lowConfidence = fullText.length === 0 || confidence < 70;
        const result = {
            content: fullText.slice(0, OCR_OUTPUT_LIMIT),
            truncated: fullText.length > OCR_OUTPUT_LIMIT,
            warnings: [
                ...(fullText.length === 0 ? ['No readable text was detected in the image.'] : []),
                ...(lowConfidence && fullText.length > 0 ? ['OCR confidence is low; confirm the extracted facts with the user before writing.'] : []),
            ],
            ocr: {
                engine: 'tesseract.js', version: exports.OCR_CACHE_VERSION, languages: ['chi_sim', 'eng'],
                confidence, lowConfidence, cacheHit: false,
                source: { page: 1, regions: Array.isArray(recognized.regions) ? recognized.regions.slice(0, 20) : [] },
            },
        };
        this.WriteOcrCache(hash, result);
        return result;
    }
    /** 按受限文件类型分派解析器，所有输出均受 5,000 字符上下文上限约束。 */
    async ReadAuthorizedFile(filePath, sourceName = filePath) {
        const metadata = this._authorizedMetadata.get(filePath);
        const authoritativeName = metadata?.name || sourceName;
        const extension = path.extname(authoritativeName).toLowerCase();
        if (extension === '.pdf')
            return this.ReadPdfFile(filePath);
        if (extension === '.docx')
            return this.ReadDocxFile(filePath);
        if (['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.py', '.java', '.go', '.rs'].includes(extension))
            return this.ReadTextFile(filePath);
        if (Object.hasOwn(IMAGE_TYPES, extension))
            return this.ReadImageFile(filePath, authoritativeName, metadata?.mimeType ?? null);
        throw new Error('This file type is not supported by the reader.');
    }
    async Close() {
        await this.ocrEngine?.Close?.();
    }
}
exports.AgentFileReader = AgentFileReader;
