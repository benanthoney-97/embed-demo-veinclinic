import Client from "./client";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined };
}) {
  const agentId = String(searchParams.agent_id ?? "");
  const inlineMode =
    String(searchParams.mode ?? "").toLowerCase() === "inline";

  return (
    <main style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
      <Client agentId={agentId} inlineMode={inlineMode} />
    </main>
  );
}