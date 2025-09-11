"use client";

import { useEffect, useState } from "react";
import { useConversation } from "@elevenlabs/react";

type Phase = "idle" | "ready" | "connecting" | "connected";

export default function Client({
  agentId,
  inlineMode = false,
}: {
  agentId: string;
  inlineMode?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>("");

  const { startSession, endSession, status } = useConversation({
    onConnect: () => setPhase("connected"),
    onDisconnect: () => setPhase("ready"),
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      setErr(msg);
    },
  });

  // Normalize SDK status to our phase
  useEffect(() => {
    const s = String(status);
    if (s === "connected") setPhase("connected");
    else if (s === "connecting") setPhase("connecting");
    else if (s === "idle" || s === "disconnected") setPhase("ready");
  }, [status]);

  async function start() {
    try {
      setErr("");
      if (!agentId) throw new Error("No agent_id provided");
      setPhase("connecting");

      if (navigator?.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      const res = await fetch(`/api/eleven/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      const data: { signedUrl?: string; error?: string } = await res.json();
      if (!res.ok || !data.signedUrl) {
        throw new Error(data.error || "Failed to get signed URL");
      }

      await startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
      });

      setPhase("connected");
    } catch (e: unknown) {
      setPhase("ready");
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      setErr(msg);
    }
  }

  async function stop() {
    try {
      await endSession();
      setPhase("ready");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      setErr(msg);
    }
  }

  const isConnected = String(status) === "connected";

  // Inline compact UI (button first, then copy)
  if (inlineMode) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 12,
          alignItems: "center",
          padding: 12,
          background: "#fff",
          border: "1px solid rgba(0,0,0,.08)",
          borderRadius: 12,
        }}
      >
        {/* Left: action controls */}
        {phase === "idle" || phase === "ready" ? (
          <button onClick={start} style={pill()}>
            Start Dialogue
          </button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "rgba(0,0,0,.6)" }}>
              {isConnected ? "Talk to interrupt" : "…"}
            </span>
            <button onClick={stop} aria-label="Stop" style={pill("soft")}>
              Stop
            </button>
          </div>
        )}

        {/* Right: explanatory/feedback text */}
        <div style={{ font: "500 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
          {phase === "connecting" ? (
            <span>Connecting…</span>
          ) : phase === "connected" ? (
            <span>Listening</span>
          ) : (
            <span>
              Dialogue lets you talk to this article at a level and language that suits you.
            </span>
          )}
          {err && (
            <div style={{ color: "#b91c1c", marginTop: 6, fontWeight: 500 }}>
              {err}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback / full embed
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={start} disabled={phase === "connecting" || isConnected}>
          {isConnected ? "Connected" : phase === "connecting" ? "Starting…" : "Start Dialogue"}
        </button>
        <button onClick={stop} disabled={!isConnected}>
          Stop
        </button>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        Status: {String(status)} | Agent: {agentId || "—"}
      </div>
      {err && <div style={{ color: "#b91c1c", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function pill(variant: "solid" | "soft" = "solid"): React.CSSProperties {
  if (variant === "soft") {
    return {
      padding: "10px 14px",
      borderRadius: 9999,
      border: "1px solid rgba(0,0,0,.12)",
      background: "#fff",
      cursor: "pointer",
    };
  }
  return {
    padding: "10px 14px",
    borderRadius: 9999,
    border: "1px solid rgba(79,70,229,.3)",
    background: "#4f46e5",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0px",
  };
}