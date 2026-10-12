import { NextResponse } from "next/server";
import { RuleError } from "@/lib/domain/task";

export async function handle(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (error) {
    if (error instanceof RuleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    const message = error instanceof Error ? error.message : "写入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
