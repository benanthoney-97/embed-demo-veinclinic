import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const key = process.env.ELEVENLABS_API_KEY!;
  const agentId = process.env.ELEVENLABS_AGENT_ID!;
  if (!key || !agentId) {
    return NextResponse.json(
      { error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID" },
      { status: 500 }
    );
  }

  // pull dynamic vars from the page URL, e.g. /api/eleven/get-signed-url?slug=...
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug") || undefined;
  const document_id = searchParams.get("document_id") || undefined;
  const doc_version_id = searchParams.get("doc_version_id") || undefined;

  // Build the payload as POST JSON. (GET query params can be ignored by Eleven.)
  const payload = {
    agent_id: agentId,

    // ✅ primary place Eleven looks for these
    dynamic_variables: {
      ...(slug ? { slug } : {}),
      ...(document_id ? { document_id } : {}),
      ...(doc_version_id ? { doc_version_id } : {}),
    },

    // extra copies for compatibility; harmless if ignored
    metadata: {
      ...(slug ? { slug } : {}),
      ...(document_id ? { document_id } : {}),
      ...(doc_version_id ? { doc_version_id } : {}),
    },
    conversation_config: {
      dynamic_variables: {
        ...(slug ? { slug } : {}),
        ...(document_id ? { document_id } : {}),
        ...(doc_version_id ? { doc_version_id } : {}),
      },
      metadata: {
        ...(slug ? { slug } : {}),
        ...(document_id ? { document_id } : {}),
        ...(doc_version_id ? { doc_version_id } : {}),
      },
    },
  };

  const res = await fetch(
    "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url",
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Failed to get signed URL: ${res.status} ${text}` },
      { status: 502 }
    );
  }

  const body = await res.json();
  return NextResponse.json({ signedUrl: body.signed_url });
}