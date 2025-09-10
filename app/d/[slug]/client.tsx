"use client";

import { useState } from "react";
import { useConversation } from "@elevenlabs/react";

export default function Client({ slug }: { slug: string }) {
  const [log, setLog] = useState<string[]>([]);
  const append = (s: string) => setLog((L) => [...L, s]);
  const [connecting, setConnecting] = useState(false);

  const { startSession, endSession, status } = useConversation({
    onConnect: () => append("✅ connected"),
    onDisconnect: () => append("🔌 disconnected"),
    onError: (e) => append(`❌ ${String(e)}`),
  });

  async function start() {
    try {
      setConnecting(true);
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const { signedUrl, error } = await fetch("/api/eleven/get-signed-url").then(r => r.json());
      if (error || !signedUrl) throw new Error(error || "No signedUrl");

      // pass the actual signed URL returned by the server
      const conversationId = await startSession({
        signedUrl,
        connectionType: "websocket",
      });
      append(`ℹ️ conversationId: ${conversationId}`);
      append(`bound slug: ${slug}`);
    } catch (e: any) {
      append(`❌ ${e?.message || String(e)}`);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div>
      <button onClick={start} disabled={connecting || status === "connected"}>
        {status === "connected" ? "Connected" : connecting ? "Starting…" : "Start"}
      </button>
      <button onClick={() => endSession()} disabled={status !== "connected"}>Stop</button>
      <p>Status: {status}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}