"use client";

import Client from "./client";

export default function Page({
  searchParams,
}: {
  searchParams: { [k: string]: string | string[] | undefined };
}) {
  const agentId = String(searchParams.agent_id ?? "");
  const inlineMode =
    String(searchParams.mode ?? "").toLowerCase() === "inline";

  return (
    <main
      style={{
        position: "relative",
        width: "100%",
        height: "100vh",
        overflow: "hidden",
      }}
    >

      {/* Widget overlay */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100%",
        }}
      >
        <div
          style={{
            background: "#f8f7f3",
            borderRadius: 12,
            padding: 0,
            maxWidth: 500,
            width: "100%",
          }}
        >
          <Client agentId={agentId} inlineMode={inlineMode} />
        </div>
      </div>
    </main>
  );
}