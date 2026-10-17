import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { routeProjectMessage } from "../lib/collaboration/router.ts";

type RoutingCase = {
  id: string;
  text: string;
  expected: "conversation" | "new_workflow";
  source: string;
};

const file = path.join(process.cwd(), "evals", "message-routing.jsonl");
const lines = (await fs.readFile(file, "utf8"))
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const cases = lines.map((line, index) => {
  try {
    return JSON.parse(line) as RoutingCase;
  } catch (error) {
    throw new Error(`路由评估第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : "解析失败"}`);
  }
});

const failures: { id: string; expected: string; actual: string; text: string }[] = [];
for (const item of cases) {
  const actual = routeProjectMessage(item.text).intent.type;
  if (actual !== item.expected) failures.push({ id: item.id, expected: item.expected, actual, text: item.text });
}

const passed = cases.length - failures.length;
const accuracy = cases.length === 0 ? 0 : passed / cases.length;
console.log(JSON.stringify({ suite: "message-routing", total: cases.length, passed, failed: failures.length, accuracy }, null, 2));
for (const failure of failures) console.log(JSON.stringify(failure));

if (cases.length < 30) {
  console.error("路由基线至少需要 30 条用例；第五期收口前扩展到 50 条以上。");
  process.exitCode = 1;
} else if (failures.length > 0) {
  process.exitCode = 1;
}

