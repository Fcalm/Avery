import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateVisionUserMessage, DetectSupportedImageMimeType, HydrateVisionMessage, SupportsVisionInput } from '../../../apps/backend/src/electron/backend/vision-input';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('vision input', () => {
  it('只为声明支持视觉的官方模型启用图片输入', () => {
    expect(SupportsVisionInput('DeepSeek', 'deepseek-v4-flash-vision-exp')).toBe(true);
    expect(SupportsVisionInput('Z.AI', 'glm-5.3-flash')).toBe(true);
    expect(SupportsVisionInput('DeepSeek', 'deepseek-v4-flash')).toBe(false);
    expect(SupportsVisionInput('自定义', 'glm-5.3-flash')).toBe(false);
  });
  it('按真实文件签名识别官方支持格式，不信任文件名', () => {
    expect(DetectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(DetectSupportedImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(DetectSupportedImageMimeType(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(DetectSupportedImageMimeType(Buffer.from('RIFF0000WEBP'))).toBe('image/webp');
    expect(DetectSupportedImageMimeType(Buffer.from('%PDF-1.7'))).toBeNull();
  });

  it('将受控附件转换成 image_url data URL，并可由虚拟 URI 在后续 Run 重新水合', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'offerget-vision-'));
    temporaryDirectories.push(directory);
    const physicalPath = join(directory, 'misleading.txt');
    writeFileSync(physicalPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const resolve = async () => ({ mimeType: 'text/plain', physicalPath });

    const current = await CreateVisionUserMessage('描述图片', [{ name: 'misleading.txt', path: 'attachment://image/misleading.txt' }], resolve);
    expect(current.providerContent).toEqual([
      { type: 'text', text: '描述图片' },
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/png;base64,/) }) }),
    ]);
    expect(current.imageAttachments).toEqual([{ uri: 'attachment://image/misleading.txt', mimeType: 'image/png', detail: 'auto' }]);

    const hydrated = await HydrateVisionMessage({ ...current, providerContent: undefined }, resolve);
    expect(hydrated.providerContent?.[1]).toMatchObject({ type: 'image_url', image_url: { detail: 'auto' } });
  });

  it('声明为图片但实际内容不受支持时显式拒绝', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'offerget-vision-invalid-'));
    temporaryDirectories.push(directory);
    const physicalPath = join(directory, 'fake.png');
    writeFileSync(physicalPath, 'not an image');

    await expect(CreateVisionUserMessage('识别', [{ name: 'fake.png', path: 'attachment://image/fake.png' }], async () => ({ mimeType: 'image/png', physicalPath })))
      .rejects.toThrow(/not a valid JPEG, PNG, GIF, or WebP/);
  });
});
