export type InformationContent = {
  description: string;
  weighing: string;
  address: string;
  mapUrl: string;
  imageData: string;
};
export type InformationState = {
  draft: InformationContent;
  published: InformationContent | null;
  administrationRevision: number;
};
export const emptyInformation: InformationContent = {
  description: '',
  weighing: '',
  address: '',
  mapUrl: '',
  imageData: '',
};

export async function readRegulationImage(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 20000000)
    throw new Error(
      'Выберите JPEG, PNG или WebP до 20 МБ / 20 МБ дейін JPEG, PNG немесе WebP таңдаңыз',
    );
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение / Суретті өңдеу мүмкін болмады');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.92, 0.85, 0.75, 0.65]) {
      const data = canvas.toDataURL('image/jpeg', quality);
      if (data.length < 666000) return data;
    }
    throw new Error('Изображение слишком большое. Выберите меньший файл / Кішірек файл таңдаңыз');
  } finally {
    URL.revokeObjectURL(url);
  }
}
