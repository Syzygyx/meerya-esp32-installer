// A dependency-free, paginated PDF. Measurements stay local until the user sends it.
export const REPORT_EMAIL = "dan@syzygyx.com";

const ascii = value => String(value ?? "")
  .replace(/→/g, " -> ").replace(/[–—−]/g, "-")
  .replace(/[…]/g, "...").replace(/[^\x20-\x7e\n]/g, "?");
const literal = value => value.replace(/([\\()])/g, "\\$1");

export function reportLines(report) {
  const lines = [];
  const add = (text = "") => {
    for (const paragraph of ascii(text).split("\n")) {
      // Hard wrapping also preserves long firmware hashes and diagnostic values.
      let rest = paragraph;
      while (rest.length > 88) {
        let cut = rest.lastIndexOf(" ", 88);
        if (cut < 35) cut = 88;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      lines.push(rest);
    }
  };
  const section = title => { add(); add(title.toUpperCase()); };
  add("Meerya test report");
  add(`Generated: ${report.generatedAt}`);
  add(`Report ID: ${report.id}`);
  add(`Return to: ${REPORT_EMAIL}`);
  add(`Overall: ${report.pass ? "PASS" : report.panelState === "fail" ? "NEEDS REVIEW" : "NOT COMPLETED"}`);
  add(`Test state: ${report.stateText}`);
  add(`Location / device: ${report.location || "Not provided"}`);
  section("User observations");
  add(report.observations || "None provided");
  section("Audio routing");
  for (const [key, label] of Object.entries(report.selectedDevices || {})) add(`${key}: ${label || "Not selected"}`);
  add("The computer stimulus tests Meerya microphone pickup. Recording replay uses");
  add("the system default output; replay loudness is not a speaker level measurement.");
  section("Measurements");
  for (const [name, column] of Object.entries(report.columns || {})) {
    add(`${name.toUpperCase()} - ${column.state || "not run"}`);
    for (const row of column.rows || []) add(`[${row.result.toUpperCase()}] ${row.text}`);
  }
  section("Microphone channel diagnostics");
  add(JSON.stringify(report.microphoneDiagnostics || {status: "not-run"}, null, 2));
  section("Firmware identity");
  add(`Selected target (expected): ${report.firmware?.target || "Unknown"}`);
  add(`Installer manifest commit: ${report.firmware?.manifestCommit || "Unknown"}`);
  add(`Running device (serial readback): ${report.firmware?.running ? JSON.stringify(report.firmware.running) : "Not connected / not read"}`);
  section("Browser and page");
  add(report.browser || "Unknown");
  add(report.page || "Unknown");
  section("Audio diagnostic log");
  add(report.audioLog || "No audio log available");
  add();
  add("This report records browser test results, not a calibrated acoustic measurement.");
  return lines;
}

export function createTestReportPdf(report) {
  const lines = reportLines(report);
  const pages = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  const objects = [null, null, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"];
  const pageRefs = [];
  for (const [index, page] of pages.entries()) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    pageRefs.push(`${pageId} 0 R`);
    const stream = `BT /F1 10 Tf 14 TL 44 744 Td\n${page.map((line, i) => `${i ? "T* " : ""}(${literal(line)}) Tj`).join("\n")}\nET\nBT /F1 9 Tf 44 30 Td (Meerya | ${literal(ascii(report.id))} | Page ${index + 1} of ${pages.length}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.join(" ")}] >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], {type: "application/pdf"});
}

export function reportEmailLink(report, filename) {
  const subject = `Meerya test ${report.id}: ${report.pass ? "passed" : "review requested"}`;
  const body = `Meerya test report\n\nPlease attach the downloaded PDF: ${filename}\n\nTest: ${report.stateText}\nLocation / device: ${report.location || "Not provided"}\nObservations: ${report.observations || "None provided"}`;
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
