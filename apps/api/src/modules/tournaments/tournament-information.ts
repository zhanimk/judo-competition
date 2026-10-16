import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export type InformationContent = {
  description: string;
  weighing: string;
  address: string;
  mapUrl: string;
  imageData: string;
};
export const emptyInformation: InformationContent = {
  description: '',
  weighing: '',
  address: '',
  mapUrl: '',
  imageData: '',
};
export function informationState(value: Prisma.JsonValue | null | undefined) {
  const state = value as {
    draft?: InformationContent;
    published?: InformationContent | null;
  } | null;
  return { draft: state?.draft ?? { ...emptyInformation }, published: state?.published ?? null };
}
export function informationContent(input: InformationContent): InformationContent {
  const content = { ...input };
  // Only explicit content fields are stored; command metadata stays in receipts.
  const result = Object.fromEntries(
    Object.keys(emptyInformation).map((key) => [
      key,
      content[key as keyof InformationContent].trim(),
    ]),
  ) as InformationContent;
  if (result.mapUrl) {
    try {
      const url = new URL(result.mapUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
    } catch {
      throw new BadRequestException('Укажите ссылку на карту с https:// или http://');
    }
  }
  if (result.imageData) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      result.imageData,
    );
    if (!match) throw new BadRequestException('Положение: разрешены только JPEG, PNG и WebP');
    const bytes = Buffer.from(match[2]!, 'base64');
    const valid =
      match[1] === 'jpeg'
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : match[1] === 'png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid || bytes.length > 500000 || bytes.toString('base64') !== match[2])
      throw new BadRequestException('Изображение повреждено или превышает 500 КБ');
  }
  return result;
}
