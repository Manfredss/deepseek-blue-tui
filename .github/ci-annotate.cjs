const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.RUNNER_TEMP || ".", "check.log");
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const failures = [];
lines.forEach((line, index) => {
  if (/^not ok\s/.test(line) || /^\u2716\s/.test(line)) failures.push(index);
});
const emit = (title, text) => {
  const safe = text
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::error title=${title}::${safe}`);
};
if (failures.length === 0) {
  emit("ci-check-log", lines.slice(-200).join("\n"));
} else {
  for (const start of failures) {
    emit(
      `ci-failure-line-${String(start + 1)}`,
      lines.slice(Math.max(0, start - 5), Math.min(lines.length, start + 45)).join("\n"),
    );
  }
}
