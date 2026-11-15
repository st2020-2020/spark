export type Source = "text" | "url" | "image";
export type Organization = { tags: string[]; summary: string };
export type Entry = {
  id: string;
  content: string;
  source: Source;
  url: string | null;
  title: string | null;
  imageUrl: string | null;
  imageName: string | null;
  summary: string;
  tags: string[];
  status: "pending" | "ready" | "fallback";
  provider: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export const sourceLabels: Record<Source, string> = {
  text: "文字",
  url: "链接",
  image: "图片",
};
