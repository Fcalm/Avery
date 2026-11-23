import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { ResolveBundledModelCapabilities, type AgentMessage } from '@avery/agent-sdk';

export const DeepSeekVisionModel = 'deepseek-v4-flash-vision-exp';
export const GlmVisionModel = 'glm-5.3-flash';
const MaximumInlineImageBytes = 32 * 1024 * 1024;

type SupportedImageMimeType = NonNullable<AgentMessage['imageAttachments']>[number]['mimeType'];
type ImageReference = NonNullable<AgentMessage['imageAttachments']>[number];

interface AttachmentInput {
  name: string;
  path: string;
}

interface ResolvedAttachment {
  mimeType?: unknown;
  physicalPath?: unknown;
  sha256?: unknown;
}

/** 按官方要求读取真实文件签名，不信任扩展名或导入时声明的 MIME。 */
export function DetectSupportedImageMimeType(header: Uint8Array): SupportedImageMimeType | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => header[index] === value)) return 'image/png';
  const ascii = new TextDecoder('ascii').decode(header);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (header.length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function ReadImage(uri: string, displayName: string, resolveAttachment: (uri: string) => Promise<unknown> | unknown, detail: ImageReference['detail'] = 'auto', signal?: AbortSignal): Promise<{ reference: ImageReference; dataUrl: string } | null> {
  signal?.throwIfAborted();
  const resolved = await resolveAttachment(uri) as ResolvedAttachment | null;
  signal?.throwIfAborted();
  if (!resolved || typeof resolved.physicalPath !== 'string') throw new Error(`Attachment ${displayName} is unavailable.`);
  const handle = await open(resolved.physicalPath, 'r');
  let header: Buffer;
  let size: number;
  try {
    const stat = await handle.stat();
    size = stat.size;
    header = Buffer.alloc(Math.min(16, size));
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const mimeType = DetectSupportedImageMimeType(header);
  const declaredAsImage = typeof resolved.mimeType === 'string' && resolved.mimeType.toLowerCase().startsWith('image/');
  const namedAsImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(displayName).toLowerCase());
  if (!mimeType) {
    if (declaredAsImage || namedAsImage) throw new Error(`Attachment ${displayName} is not a valid JPEG, PNG, GIF, or WebP image.`);
    return null;
  }
  if (size <= 0 || size > MaximumInlineImageBytes) throw new Error(`Image ${displayName} must be no larger than 32 MiB for inline vision input.`);
  const bytes = await readFile(resolved.physicalPath, { signal });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== size || DetectSupportedImageMimeType(bytes) !== mimeType || (resolved.sha256 !== undefined && resolved.sha256 !== sha256)) throw new Error('Image attachment content changed.');
  return {
    reference: { uri, mimeType, detail, sha256 },
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
  };
}

/** 独立调用方从同一随应用目录读取能力；Host 正式 Run 使用叠加用户覆盖后的快照。 */
export function SupportsVisionInput(provider: unknown, model: unknown): boolean {
  return ResolveBundledModelCapabilities(provider, model)?.inputImage === true;
}

/** 将本轮附件转换为官方 OpenAI 兼容的 text + image_url 块，同时只保留可持久化的虚拟 URI 引用。 */
export async function CreateVisionUserMessage(content: string, attachments: AttachmentInput[], resolveAttachment: (uri: string) => Promise<unknown> | unknown, signal?: AbortSignal): Promise<AgentMessage> {
  const images = (await Promise.all(attachments.map((attachment) => ReadImage(attachment.path, attachment.name, resolveAttachment, 'auto', signal)))).filter((image) => image !== null);
  if (!images.length) return { role: 'user', content };
  return {
    role: 'user',
    content,
    imageAttachments: images.map((image) => image.reference),
    providerContent: [
      { type: 'text', text: content },
      ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl, detail: image.reference.detail } })),
    ],
  };
}

/** 历史必须重放原图；不可读或内容变化时阻断本次请求，绝不以占位文字改变已有缓存前缀。 */
export async function HydrateVisionMessage(message: AgentMessage, resolveAttachment: (uri: string) => Promise<unknown> | unknown, signal?: AbortSignal): Promise<AgentMessage> {
  if (message.role !== 'user' || !message.imageAttachments?.length) return message;
  const images: Array<{ reference: ImageReference; dataUrl: string }> = [];
  for (const reference of message.imageAttachments) {
    signal?.throwIfAborted();
    try {
      const image = await ReadImage(reference.uri, reference.uri, resolveAttachment, reference.detail, signal);
      if (!image || image.reference.mimeType !== reference.mimeType || (reference.sha256 !== undefined && image.reference.sha256 !== reference.sha256)) throw new Error('Historical image changed.');
      images.push(image);
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error('历史图片读取失败或内容发生变化，请恢复原图片后继续；原上下文未改变。', { cause: error }), { code: 'STORAGE_ERROR', details: { reason: 'HISTORY_IMAGE_UNAVAILABLE' } });
    }
  }
  return {
    ...message,
    imageAttachments: images.map(image => image.reference),
    providerContent: [
      { type: 'text', text: message.content },
      ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl, detail: image.reference.detail } })),
    ],
  };
}

/** 最多四条消息并发读取，保留消息顺序，避免长历史一次分配全部图片数据和文件句柄。 */
export async function HydrateVisionHistory(history: AgentMessage[], resolveAttachment: (uri: string) => Promise<unknown> | unknown, signal: AbortSignal): Promise<AgentMessage[]> {
  const result = new Array<AgentMessage>(history.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, history.length) }, async () => {
    while (cursor < history.length) {
      signal.throwIfAborted();
      const index = cursor++;
      result[index] = await HydrateVisionMessage(history[index], resolveAttachment, signal);
    }
  }));
  return result;
}
