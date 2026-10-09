import { PublicHub } from '../../../../features/public/public-hub';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PublicHub id={id} />;
}
