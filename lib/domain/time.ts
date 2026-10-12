export type ShanghaiTime = {
  noteStamp: string;
  iso: string;
  day: string;
  sql: string;
};

export function shanghaiTime(date = new Date()): ShanghaiTime {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(/\u202f/g, " ")
    .replace(/\u00a0/g, " ");
  const [day, time] = formatted.split(" ");
  return {
    noteStamp: `${day} ${time.slice(0, 5)}`,
    iso: `${day}T${time}+08:00`,
    day,
    sql: `${day} ${time}`,
  };
}

export function toIso(value: string): string {
  if (value.includes("T")) return value;
  const trimmed = value.replace(/\.\d+$/, "");
  return `${trimmed.replace(" ", "T")}+08:00`;
}

export function toSql(value: string): string {
  if (!value.includes("T")) return value.replace(/\.\d+$/, "");
  return value.slice(0, 19).replace("T", " ");
}
