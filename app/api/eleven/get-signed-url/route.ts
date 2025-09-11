import { NextResponse } from "next/server";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY!;
  if (!key) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "Missing agent_id" }, { status: 400 });
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
      agentId
    )}`,
    { headers: { "xi-api-key": key } }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Failed to get signed URL: ${res.status} ${text}` },
      { status: 502 }
    );
  }

  const body = await res.json();
  // { signed_url: "wss://..." }
  return NextResponse.json({ signedUrl: body.signed_url });
}