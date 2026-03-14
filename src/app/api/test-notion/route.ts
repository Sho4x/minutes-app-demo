import { NextResponse } from "next/server";

export async function GET() {
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
    },
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
