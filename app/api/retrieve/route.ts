// app/api/retrieve/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";

import { supabaseAdmin } from "@/lib/supabase";
import { Pinecone } from "@pinecone-database/pinecone";
import OpenAI from "openai";

// --- env / singletons
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pc.index(process.env.PINECONE_INDEX!);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

export async function POST(req: Request) {
  const trace = getTraceId();
  const t0 = Date.now();

  try {
    const body = await req.json();
    const q: string = (body?.q ?? "").toString().trim();
    if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });

    const topK = clampInt(body?.topK ?? 5, 1, 10);

    // Accept either explicit IDs or a slug we resolve
    let document_id: string | undefined = body?.document_id;
    let doc_version_id: string | undefined = body?.doc_version_id;

    if (!document_id || !doc_version_id) {
      const slug: string = (body?.slug ?? "").toString().trim();
      if (!slug) {
        return NextResponse.json(
          { error: "Provide slug or (document_id + doc_version_id)" },
          { status: 400 }
        );
      }
      const tSlug = Date.now();
      const ss = await supabaseAdmin
        .from("share_surfaces")
        .select("document_id, live_version_id")
        .eq("page_slug", slug)
        .single();
      logLatency("retrieve", trace, { step: "lookup_slug", ms: Date.now() - tSlug, slug });

      if (ss.error || !ss.data) {
        return NextResponse.json({ error: "Unknown slug" }, { status: 404 });
      }
      document_id = ss.data.document_id;
      doc_version_id = ss.data.live_version_id;
    }

    // 1) Embed query
    const t1 = Date.now();
    const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
    const vec = emb.data?.[0]?.embedding;
    logLatency("retrieve", trace, { step: "embed", ms: Date.now() - t1, q_len: q.length });
    if (!vec) return NextResponse.json({ error: "Embedding failed" }, { status: 500 });

    // 2) Pinecone similarity search
    const t2 = Date.now();
    const namespace = `doc:${document_id}:v:${doc_version_id}`;
    const res = await index.namespace(namespace).query({
      vector: vec,
      topK,
      includeMetadata: true,
    });
    const hits = res.matches ?? [];
    logLatency("retrieve", trace, { step: "pinecone_query", ms: Date.now() - t2, hits: hits.length });

    // Done
    logLatency("retrieve", trace, { step: "total", ms: Date.now() - t0 });
    return NextResponse.json({
      ok: true,
      q,
      results: hits.map((h) => ({
        id: h.id,
        score: h.score,
        idx: Number.isFinite(Number(h.metadata?.idx)) ? Number(h.metadata?.idx) : null,
        path: (h.metadata?.path as string) ?? "root",
        snippet: (h.metadata?.text_snippet as string) ?? null,
        section: null, // keep lean; skip DB section fetch for speed
      })),
      document_id,
      doc_version_id,
    });
  } catch (e: any) {
    console.error(`[latency][retrieve] trace=${trace} ERROR:`, e?.message || e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

/* --------------- helpers --------------- */
function clampInt(n: any, min: number, max: number) {
  const v = Number(n) || 0;
  return Math.max(min, Math.min(v, max));
}
function getTraceId() {
  // @ts-ignore
  return globalThis.crypto?.randomUUID?.() || String(Date.now());
}
function logLatency(scope: string, trace: string, data: Record<string, any>) {
  try { console.log(`[latency][${scope}] trace=${trace} ${JSON.stringify(data)}`); } catch {}
}