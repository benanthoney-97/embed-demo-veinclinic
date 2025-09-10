// app/api/dialogues/create/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
function randomSuffix(n = 8) {
  return Math.random().toString(16).slice(2, 2 + n);
}

export async function POST(req: Request) {
  try {
    const { title, pageSlugBase, objectPath, mode = "development", privacy = "private" } =
      await req.json();

    if (!title || !pageSlugBase || !objectPath) {
      return NextResponse.json(
        { error: "title, pageSlugBase, objectPath required" },
        { status: 400 }
      );
    }

    // 1) documents
    const docSlug = `${slugify(pageSlugBase)}-${randomSuffix(8)}`;
    const docIns = await supabaseAdmin
      .from("documents")
      .insert([{ title, slug: docSlug }])
      .select("id, slug")
      .single();

    if (docIns.error || !docIns.data) {
      return NextResponse.json(
        { error: docIns.error?.message || "documents insert failed" },
        { status: 500 }
      );
    }
    const document_id = docIns.data.id as string;

    // 2) doc_versions (let the table default the status)
    const verIns = await supabaseAdmin
      .from("doc_versions")
      .insert([{ document_id, source_uri: objectPath, version: 1 }])
      .select("id, status, version, source_uri")
      .single();

    if (verIns.error || !verIns.data) {
      return NextResponse.json(
        { error: verIns.error?.message || "doc_versions insert failed" },
        { status: 500 }
      );
    }
    const doc_version_id = verIns.data.id as string;

    // 3) share_surfaces (only select existing columns; your table has no `id`)
    const page_slug = docSlug;
    const page_url = `/d/${page_slug}`;

    const surfIns = await supabaseAdmin
      .from("share_surfaces")
      .insert([
        {
          document_id,
          live_version_id: doc_version_id,
          page_slug,
          page_url,        // keep this only if your table has it (your earlier sample did)
          mode,
          privacy,
        },
      ])
      .select("document_id, live_version_id, page_slug, page_url")
      .single();

    if (surfIns.error || !surfIns.data) {
      return NextResponse.json(
        { error: surfIns.error?.message || "share_surfaces insert failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      document_id,
      doc_version_id,
      page_slug,
      page_url,
      title,
      source_uri: objectPath,
      mode,
      privacy,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}