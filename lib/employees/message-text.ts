const thinkingMark = "---思考---\n";
const replyMark = "\n---回复---\n";

export function composeReply(reasoning: string, content: string): string {
  const think = reasoning.trim();
  const answer = content.trim();
  if (!think) return answer;
  if (!answer) return `${thinkingMark}${think}`;
  return `${thinkingMark}${think}${replyMark}${answer}`;
}

export function parseProjectTurn(text: string): { thinking: string; reply: string } {
  const match = text.trim().match(/对项目的思考：\s*([\s\S]*?)\n+回复：\s*([\s\S]*)$/);
  if (!match) return { thinking: "", reply: text.trim() };
  return { thinking: match[1].trim(), reply: match[2].trim() };
}

const replyMarker = "回复：";

export function replySoFar(content: string): string {
  const index = content.indexOf(replyMarker);
  if (index === -1) return "";
  return content.slice(index + replyMarker.length).replace(/^\s+/, "");
}

export function splitReply(body: string): { reasoning: string; answer: string } {
  if (!body.startsWith(thinkingMark)) return { reasoning: "", answer: body };
  const rest = body.slice(thinkingMark.length);
  const cut = rest.indexOf(replyMark);
  if (cut === -1) return { reasoning: rest.trim(), answer: "" };
  return {
    reasoning: rest.slice(0, cut).trim(),
    answer: rest.slice(cut + replyMark.length).trim(),
  };
}
