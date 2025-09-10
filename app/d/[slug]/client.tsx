"use client";

import { useState } from "react";
import { useConversation } from "@elevenlabs/react";

type Status = "idle" | "connecting" | "connected" | "disconnected" | string;

export default function Client({ slug }: { slug: string }) {
  const [log, setLog] = useState<string[]>([]);
  const append = (s: string) => setLog((L) => [...L, s]);
  const [connecting, setConnecting] = useState(false);

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
      setConnecting(true);

      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        append("⚠️ Microphone API not available in this environment.");
      }

      const res = await fetch("/api/eleven/get-signed-url");
      const data: { signedUrl?: string; error?: string } = await res.json();
      if (data.error || !data.signedUrl) {
        throw new Error(data.error || "No signedUrl returned");
      }

      const conversationId = await startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
        // no `metadata` here – not supported by the type
      });

      append(`ℹ️ conversationId: ${conversationId}`);
      append(`bound slug: ${slug}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      append(`❌ ${msg}`);
    } finally {
      setConnecting(false);
    }
  }

  const isConnected = (status as Status) === "connected";

  return (
    <div>
      <button onClick={start} disabled={connecting || isConnected}>
        {isConnected ? "Connected" : connecting ? "Starting…" : "Start"}
      </button>
      <button onClick={() => endSession()} disabled={!isConnected}>
        Stop
      </button>
      <p>Status: {String(status)}</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{log.join("\n")}</pre>
    </div>
  );
}