import Client from "./client";

// If you statically generate elsewhere, you can remove this.
export const dynamic = "force-dynamic";

export default async function Page(
  props: { params: Promise<{ slug: string }> } // 👈 note: Promise here
) {
  const { slug } = await props.params;         // 👈 await it

  return (
    <main>
      <h1>Dialogue: {slug}</h1>
      <Client slug={slug} />
    </main>
  );
}