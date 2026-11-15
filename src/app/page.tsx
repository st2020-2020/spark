import { after } from "next/server";
import { Inbox } from "@/components/inbox";
import { listEntries, resumePending } from "@/lib/entries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default function Home() {
  const entries = listEntries();
  after(resumePending);
  return <Inbox initialEntries={entries} />;
}
