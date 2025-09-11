"use client";

import { useEffect, useState, type CSSProperties } from "react";
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

  // speaking state we toggle from SDK callbacks
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);

  const { startSession, endSession, status } = useConversation({
    onConnect: () => setPhase("connected"),
    onDisconnect: () => {
      setPhase("ready");
      setAgentSpeaking(false);
      setUserSpeaking(false);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      setErr(msg);
    },

    // The SDK may expose these; if your typings don’t yet, ts-expect-error keeps lint happy.
    onAgentStartSpeaking: () => {
      setAgentSpeaking(true);
      setUserSpeaking(false);
    },
    onAgentStopSpeaking: () => setAgentSpeaking(false),
    onUserStartSpeaking: () => {
      setUserSpeaking(true);
      setAgentSpeaking(false);
    },
    onUserStopSpeaking: () => setUserSpeaking(false),
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

      const res = await fetch(
        `/api/eleven/get-signed-url?agent_id=${encodeURIComponent(agentId)}`
      );
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
      setAgentSpeaking(false);
      setUserSpeaking(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      setErr(msg);
    }
  }

  const isConnected = String(status) === "connected";

  // Inline compact UI (button first, then copy)
  if (inlineMode) {
    const rightLabel =
      phase === "connecting"
        ? "Connecting…"
        : phase === "connected"
        ? agentSpeaking
          ? "Talk to interrupt"
          : "Listening"
        : "Dialogue lets you talk to this article at a level and language that suits you.";

    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: 12,
          alignItems: "center", // vertical middle in each cell
          padding: 12,
          background: "#fff",
          border: "0px",
          borderRadius: 12,
        }}
      >
        {/* Left: action controls */}
        {phase === "idle" || phase === "ready" ? (
          <button
            onClick={start}
            style={pill("solid")}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#4338ca")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#4f46e5")}
          >
            Start Dialogue
          </button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              onClick={stop}
              aria-label="Stop"
              style={pill("soft")}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f8f8")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              {/* Black square icon */}
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "#000",
                  borderRadius: 2,
                  marginRight: 6,
                }}
              />
              Stop
            </button>
          </div>
        )}

        {/* Right: single status line */}
        <div
          style={{
            font: "600 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          }}
        >
          <span>{rightLabel}</span>
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
        <button
          onClick={start}
          disabled={phase === "connecting" || isConnected}
          style={pill("solid")}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#4338ca")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "#4f46e5")}
        >
          {isConnected ? "Connected" : phase === "connecting" ? "Starting…" : "Start Dialogue"}
        </button>
        <button
          onClick={stop}
          disabled={!isConnected}
          style={pill("soft")}
          onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f8f8")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "#000",
              borderRadius: 2,
              marginRight: 6,
            }}
          />
          Stop
        </button>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
        {/* In full embed we can show both states together */}
        {agentSpeaking ? "Talk to interrupt" : userSpeaking ? "Listening" : "Ready"}
        {" · "}
        Status: {String(status)} | Agent: {agentId || "—"}
      </div>
      {err && <div style={{ color: "#b91c1c", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function pill(variant: "solid" | "soft" = "solid"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 14px",
    borderRadius: 9999,
    cursor: "pointer",
    boxShadow: "0px",
    transition: "background 120ms ease, opacity 120ms ease",
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontWeight: 600,
    fontSize: 14,
    lineHeight: 1.2 as any,
    appearance: "none" as any,
  };

  if (variant === "soft") {
    return {
      ...base,
      border: "1px solid rgba(0,0,0,.12)",
      background: "#fff",
      color: "#000",
    };
  }

  return {
    ...base,
    border: "1px solid rgba(79,70,229,.3)",
    background: "#4f46e5",
    color: "#fff",
  };
}