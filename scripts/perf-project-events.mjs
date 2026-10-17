const baseUrl = process.env.OPC_BASE_URL ?? "http://127.0.0.1:3000";
const projectId = process.env.OPC_PERF_PROJECT_ID ?? "p-001";
const thresholdMs = Number(process.env.OPC_EVENT_MEDIAN_LIMIT_MS ?? 250);
const url = `${baseUrl}/api/projects/${projectId}/events?limit=500`;
const times = [];

for (let index = 0; index < 6; index += 1) {
  const started = performance.now();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`事件接口返回 ${response.status}`);
  await response.arrayBuffer();
  times.push(Math.round(performance.now() - started));
}

const warm = times.slice(1).sort((left, right) => left - right);
const medianMs = warm[Math.floor(warm.length / 2)];
console.log(JSON.stringify({ url, times, medianMs, thresholdMs }));
if (medianMs > thresholdMs) process.exitCode = 1;

