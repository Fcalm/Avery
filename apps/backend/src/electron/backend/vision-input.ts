import { open, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMessage } from '@offerget/agent-sdk';

export const DeepSeekVisionModel = 'deepseek-v4-flash-vision-exp';
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

async function ReadImage(uri: string, displayName: string, resolveAttachment: (uri: string) => Promise<unknown> | unknown, detail: ImageReference['detail'] = 'auto'): Promise<{ reference: ImageReference; dataUrl: string } | null> {
  const resolved = await resolveAttachment(uri) as ResolvedAttachment | null;
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
  if (size <= 0 || size > MaximumInlineImageBytes) throw new Error(`Image ${displayName} must be no larger than 32 MiB for inline DeepSeek vision input.`);
  const bytes = await readFile(resolved.physicalPath);
  return {
    reference: { uri, mimeType, detail },
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
  };
}

/** 将本轮附件转换为官方 OpenAI 兼容的 text + image_url 块，同时只保留可持久化的虚拟 URI 引用。 */
export async function CreateVisionUserMessage(content: string, attachments: AttachmentInput[], resolveAttachment: (uri: string) => Promise<unknown> | unknown): Promise<AgentMessage> {
  const images = (await Promise.all(attachments.map((attachment) => ReadImage(attachment.path, attachment.name, resolveAttachment)))).filter((image) => image !== null);
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

/** 后续 Run 用受控 URI 重新水合历史图片；物理路径与 Base64 均不进入持久化历史。 */
export async function HydrateVisionMessage(message: AgentMessage, resolveAttachment: (uri: string) => Promise<unknown> | unknown): Promise<AgentMessage> {
  if (message.role !== 'user' || !message.imageAttachments?.length) return message;
  const images = await Promise.all(message.imageAttachments.map(async (reference) => {
    const image = await ReadImage(reference.uri, reference.uri, resolveAttachment, reference.detail);
    if (!image || image.reference.mimeType !== reference.mimeType) throw new Error('A referenced vision attachment changed or is no longer a supported image.');
    return image;
  }));
  return {
    ...message,
    providerContent: [
      { type: 'text', text: message.content },
      ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: image.dataUrl, detail: image.reference.detail } })),
    ],
  };
}
