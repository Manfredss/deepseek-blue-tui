const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.RUNNER_TEMP || ".", "check.log");
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
const failures = [];
lines.forEach((line, index) => {
  if (/^not ok\s/.test(line)) failures.push(index);
});
const emit = (title, text) => {
  const safe = text
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.log(`::error title=${title}::${safe}`);
};
if (failures.length === 0) {
  emit("ci-check-log", lines.slice(-160).join("\n"));
} else {
  for (const start of failures) {
    let end = start + 1;
    while (
      end < lines.length &&
      !/^ok\s+\d+\s/.test(lines[end]) &&
      !/^#\s+(tests|pass|fail|cancelled)/.test(lines[end])
    ) {
      end += 1;
    }
    emit(
      `ci-failure-line-${String(start + 1)}`,
      lines.slice(start, Math.min(lines.length, end + 20)).join("\n"),
    );
  }
}
