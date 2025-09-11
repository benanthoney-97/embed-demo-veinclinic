import Client from "./client";
export const dynamic = "force-dynamic";

export default async function Page(
  props: { params: Promise<{ slug: string }> }
) {
  const { slug } = await props.params;
  return (
    <main>
      <h1>Dialogue: {slug}</h1>
      <Client slug={slug} />
    </main>
  );
}