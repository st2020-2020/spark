import { after } from "next/server";
import { notFound } from "next/navigation";
import { getEntry, enrichEntry } from "@/lib/entries";
import { EntryDetail } from "@/components/entry-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
};
export async function generateMetadata({ params }: Props) {
  const entry = getEntry((await params).id);
  return { title: entry?.title || entry?.content.slice(0, 32) || "记录详情" };
}
export default async function Page({ params, searchParams }: Props) {
  const entry = getEntry((await params).id);
  if (!entry) notFound();
  if (entry.status === "pending") after(() => enrichEntry(entry.id));
  const from = (await searchParams).from;
  const returnPath =
    from && (from === "/" || from.startsWith("/?")) ? from : "/";
  return <EntryDetail initialEntry={entry} returnPath={returnPath} />;
}
