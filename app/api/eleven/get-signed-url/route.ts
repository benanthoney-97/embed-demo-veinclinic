// app/api/eleven/get-signed-url/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const key = process.env.ELEVENLABS_API_KEY!;
    const agentId = process.env.ELEVENLABS_AGENT_ID!;

    if (!key || !agentId) {
      return NextResponse.json(
        { error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID" },
        { status: 500 }
      );
    }

    // Pull dynamic vars from the page/client
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug") || undefined;
    const document_id = url.searchParams.get("document_id") || undefined;
    const doc_version_id = url.searchParams.get("doc_version_id") || undefined;

    // Build the ConvAI get-signed-url request
    const api = new URL(
      "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url"
    );
    api.searchParams.set("agent_id", agentId);

    // Attach variables as metadata so your ElevenLabs Tool can reference them
    // Tool config can then use: {{variables.slug}}, {{variables.document_id}}, {{variables.doc_version_id}}
    const variables: Record<string, string> = {};
    if (slug) variables.slug = slug;
    if (document_id) variables.document_id = document_id;
    if (doc_version_id) variables.doc_version_id = doc_version_id;

    if (Object.keys(variables).length > 0) {
      // ElevenLabs ConvAI accepts a 'metadata' param; we pass variables under that
      api.searchParams.set(
        "metadata",
        JSON.stringify({ variables })
      );
    }

    const res = await fetch(api.toString(), {
      headers: { "xi-api-key": key },
      // GET is correct for this endpoint
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Failed to get signed URL: ${res.status} ${text}` },
        { status: 502 }
      );
    }

    const body = (await res.json()) as { signed_url?: string };
    if (!body?.signed_url) {
      return NextResponse.json(
        { error: "No signed_url in ElevenLabs response" },
        { status: 502 }
      );
    }

    return NextResponse.json({ signedUrl: body.signed_url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}