import { BoardView } from "./components/board";
import { loadBoard } from "@/lib/application/board";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>;
}) {
  const params = await searchParams;
  try {
    const board = await loadBoard();
    return <BoardView board={board} initialTaskId={params.task ?? null} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : "数据库还没连上";
    return (
      <main className="boot-error">
        <h1>看板还没连上 MySQL</h1>
        <p>{message}</p>
        <p>把连接串写进 .env.local 的 DATABASE_URL，并确认库用户能建库 opc。</p>
      </main>
    );
  }
}
