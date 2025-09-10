// app/api/retrieve/route.ts
import { NextResponse } from "next/server";
export const runtime = "nodejs";

import { supabaseAdmin } from "@/lib/supabase";
import {
  Pinecone,
  type Index,
  type RecordMetadata,
  type ScoredPineconeRecord,
} from "@pinecone-database/pinecone";
import OpenAI from "openai";

/* --- env --- */
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";

/* --- lazy singletons --- */
let _pineconeIndex: Index | null = null;
let _openai: OpenAI | null = null;

function getPineconeIndex(): Index {
  if (_pineconeIndex) return _pineconeIndex;
  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX;
  if (!apiKey || !indexName) {
    throw new Error("Missing PINECONE_API_KEY or PINECONE_INDEX.");
  }
  const pc = new Pinecone({ apiKey });
  _pineconeIndex = pc.index(indexName);
  return _pineconeIndex;
}

function getOpenAI(): OpenAI {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY.");
  _openai = new OpenAI({ apiKey: key });
  return _openai;
}

/* request typing */
type Loose = Record<string, unknown>;

interface RetrievePayload {
  q?: unknown;
  question?: unknown;
  prompt?: unknown;
  topK?: unknown;
  topk?: unknown;
  document_id?: string;
  doc_version_id?: string;
  slug?: string;
}

export async function POST(req: Request) {
  const trace = getTraceId();
  try {
    const raw = await req.text().catch(() => "");
    const parsed: Loose = raw ? (JSON.parse(raw) as Loose) : {};

    const p: RetrievePayload = (parsed as RetrievePayload) ?? {};
    const q = String(p.q ?? p.question ?? p.prompt ?? "").trim();
    const topK = clampInt(p.topK ?? p.topk ?? 5, 1, 10);

    if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });

    let { document_id, doc_version_id } = p;
    const { slug } = p;

    if ((!document_id || !doc_version_id) && slug) {
      const ss = await supabaseAdmin
        .from("share_surfaces")
        .select("document_id, live_version_id")
        .eq("page_slug", slug)
        .single();

      if (ss.error || !ss.data) {
        return NextResponse.json({ error: "Unknown slug" }, { status: 404 });
      }
      document_id = ss.data.document_id;
      doc_version_id = ss.data.live_version_id;
    }

    if (!document_id || !doc_version_id) {
      return NextResponse.json(
        { error: "Provide slug or (document_id + doc_version_id)" },
        { status: 400 }
      );
    }

    const openai = getOpenAI();
    const index = getPineconeIndex();

    // embed query
    const emb = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: q });
    const vec = emb.data?.[0]?.embedding;
    if (!vec) return NextResponse.json({ error: "Embedding failed" }, { status: 500 });

    // pinecone query
    const namespace = `doc:${document_id}:v:${doc_version_id}`;
    const res = await index.namespace(namespace).query({
      vector: vec,
      topK,
      includeMetadata: true,
    });

    const matches: ScoredPineconeRecord<RecordMetadata>[] = res.matches ?? [];

    return NextResponse.json({
      ok: true,
      hits: matches.map((m) => ({
        score: m.score,
        idx: (m.metadata?.idx as number | undefined) ?? null,
        path: (m.metadata?.path as string | undefined) ?? "root",
        snippet: (m.metadata?.text_snippet as string | undefined) ?? "",
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[retrieve] trace=", trace, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* helpers */
function clampInt(v: unknown, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(n, max));
}
function getTraceId() {
  try {
    const g = globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } };
    return g.crypto?.randomUUID?.() ?? String(Date.now());
  } catch {
    return String(Date.now());
  }
}