"use client";

import Client from "./client";

const BEIGE = "#ddfaee";

export default function Page({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const agentId = String(searchParams.agent_id ?? "");
  const inlineMode = String(searchParams.mode ?? "").toLowerCase() === "inline";

  return (
    <main
      style={{
        position: "relative",
        width: "100%",
        minHeight: "100dvh",     // better for mobile than 100vh
        overflow: "hidden",
        background: BEIGE,       // <-- give the page itself the beige
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
          minHeight: "100dvh",
        }}
      >
        <div
          style={{
            // background: "rgba(255, 255, 255, 0.85)", // ❌ remove the white wash
            background: BEIGE,                         // ✅ keep it beige (or omit entirely)
            borderRadius: 12,
            padding: 0,
            maxWidth: 500,
            width: "100%",
            overflow: "hidden",                        // avoid hairline edges with radius
            backgroundClip: "padding-box",
          }}
        >
          <Client agentId={agentId} inlineMode={inlineMode} />
        </div>
      </div>
    </main>
  );
}