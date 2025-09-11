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
      {/* Background video */}
      <video
        src="https://s3.amazonaws.com/webflow-prod-assets/68b59d29ddcf16e13ebee38f/68b59d2bddcf16e13ebee4b7_Vibrant%20Abstract%20Artwork.mp4"
        autoPlay
        muted
        loop
        playsInline
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          zIndex: 0,
        }}
      />

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
            background: "rgba(255, 255, 255, 0.85)",
            borderRadius: 12,
            padding: 16,
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