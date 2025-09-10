import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY!;
  const agentId = process.env.ELEVENLABS_AGENT_ID!;
  if (!key || !agentId) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID" }, { status: 500 });
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": key } }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: `Failed to get signed URL: ${res.status} ${text}` }, { status: 502 });
  }

  const body = await res.json();
  // ElevenLabs responds with { signed_url: "wss://..." }
  return NextResponse.json({ signedUrl: body.signed_url });
}