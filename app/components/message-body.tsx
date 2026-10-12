import { splitReply } from "@/lib/employees/message-text";

export function MessageBody({ body }: { body: string }) {
  const { reasoning, answer } = splitReply(body);
  return (
    <>
      {reasoning ? (
        <details className="thinking" open>
          <summary>思考</summary>
          <p>{reasoning}</p>
        </details>
      ) : null}
      {answer ? <p>{answer}</p> : null}
    </>
  );
}
