"use client";

import { useState } from "react";
import { useConversation } from "@elevenlabs/react";

type Status = "idle" | "connecting" | "connected" | "disconnected" | string;

export default function Client({ agentId }: { agentId: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const append = (s: string) => setLog((L) => [...L, s]);

  const { startSession, endSession, status } = useConversation({
    onConnect: () => append("✅ connected"),
    onDisconnect: () => append("🔌 disconnected"),
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      append(`❌ ${msg}`);
    },
  });

  async function start() {
    try {
      if (!agentId) throw new Error("No agent_id provided");
      setConnecting(true);

      // Ask for mic
      if (navigator?.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // Get signed URL for this agent
      const res = await fetch(`/api/eleven/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      const data: { signedUrl?: string; error?: string } = await res.json();
      if (data.error || !data.signedUrl) throw new Error(data.error || "No signedUrl");

      await startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      append(`❌ ${msg}`);
    } finally {
      setConnecting(false);
    }
  }

  const isConnected = (status as Status) === "connected";

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={start} disabled={connecting || isConnected}>
          {isConnected ? "Connected" : connecting ? "Starting…" : "Start"}
        </button>
        <button onClick={() => endSession()} disabled={!isConnected}>
          Stop
        </button>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        Status: {String(status)} | Agent: {agentId || "—"}
      </div>
      <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{log.join("\n")}</pre>
    </div>
  );
}