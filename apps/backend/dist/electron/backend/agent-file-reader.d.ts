export declare const OCR_CACHE_VERSION = "tesseract-7.0.0-chi_sim+eng-v1";
/** 仅依据文件头识别 V1 允许的图片类型，避免扩展名伪装进入解码器。 */
export declare function DetectImageMime(buffer: Buffer): string | null;
interface OcrEngine {
    Recognize(image: Buffer): Promise<{
        text: string;
        confidence: number;
        regions: Array<{
            text: string;
            confidence: number | null;
            bbox: {
                x0: number;
                y0: number;
                x1: number;
                y1: number;
            } | null;
        }>;
    }>;
    Close(): Promise<void>;
}
/** Tesseract.js 的离线执行器：语言数据从随包 npm 依赖复制到 userData，绝不回退到 CDN。 */
export declare class LocalTesseractOcrEngine implements OcrEngine {
    private runtimeRoot;
    private workerPromise;
    private queue;
    constructor(runtimeRoot: string);
    private PrepareLanguageData;
    private GetWorker;
    Recognize(image: Buffer): Promise<{
        text: string;
        confidence: number;
        regions: Array<{
            text: string;
            confidence: number | null;
            bbox: {
                x0: number;
                y0: number;
                x1: number;
                y1: number;
            } | null;
        }>;
    }>;
    Close(): Promise<void>;
}
/**
 * 宿主侧文件读取端口（FileReadPort 注入默认 tools 模块）：
 * 承载 pdf/docx/txt 解析、物理路径校验与资源边界；默认模块不持有任何 Node 解析能力。
 * 注意：pdf-parse/mammoth 仅在解析方法首次调用时 require——该时机必然晚于 apps/backend/dist/index.js 的
 * InstallBrowserPolyfills()（启动即注入），因此首用加载不会破坏 pdf-parse 的浏览器全局依赖。
 */
export declare class AgentFileReader {
    private _resolveAttachment;
    private _authorizedMetadata;
    private ocrCacheRoot;
    private ocrEngine;
    constructor(ResolveAttachmentUri: (uri: string) => Promise<unknown>, options?: {
        ocrCacheRoot?: string | null;
        ocrRuntimeRoot?: string;
        ocrEngine?: OcrEngine;
    });
    SetOcrCacheRoot(cacheRoot: string | null): void;
    /** FileReadPort 接口：将 attachment:// 虚拟 URI 解析为宿主私有物理路径；回调返回字符串或含 physicalPath 的对象，统一归一化；未注册返回 null。 */
    ResolveAttachmentUri(uri: string): Promise<string | null>;
    /** 解析项目内请求路径并校验真实路径仍位于会话绑定的项目目录，拒绝符号链接越界。 */
    ResolveProjectPath(projectRoot: string | null, requestedPath: string): string;
    /** 枚举项目环境内的常规文件，跳过依赖缓存、隐藏目录和符号链接，限制扫描规模；返回绝对路径与相对 POSIX 路径。 */
    ListProjectFiles(projectPath: string, limit?: number): Array<{
        path: string;
        name: string;
    }>;
    /** 将受限 Glob 模式转换为文件名匹配正则，先保护双星号以避免被单星号二次替换。 */
    CreateGlobMatcher(pattern: string): RegExp;
    /** 读取受限文本内容：所有文件受 5 MB 物理上限及 5,000 字符上下文上限保护。 */
    ReadTextFile(filePath: string): {
        content: string;
        truncated: boolean;
    };
    /** 提取受限 DOCX 文本；仅读取段落与表格文本，不执行宏、脚本或外部链接。 */
    ReadDocxFile(filePath: string): Promise<{
        content: string;
        truncated: boolean;
        warnings: string[];
    }>;
    /** 提取不超过十页的 PDF 文本；扫描型或无文本层 PDF 会明确返回空文本。 */
    ReadPdfFile(filePath: string): Promise<{
        content: string;
        truncated: boolean;
        pages: number;
        needsOcr: boolean;
    }>;
    private ReadOcrCache;
    private WriteOcrCache;
    /** 校验扩展名、声明 MIME 与文件魔数，解码归一化后执行完全离线 OCR。 */
    ReadImageFile(filePath: string, sourceName?: string, declaredMimeType?: string | null): Promise<any>;
    /** 按受限文件类型分派解析器，所有输出均受 5,000 字符上下文上限约束。 */
    ReadAuthorizedFile(filePath: string, sourceName?: string): Promise<any>;
    Close(): Promise<void>;
}
export {};
