// Meerya CDC OTA v1. Native app CDC only; never toggles RTS to enter ROM.
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class ResponseTimeout extends Error {}

export async function inspectImage(file) {
  if (file.size < 288 || file.size > 16 * 1024 * 1024) {
    throw new Error("Choose an app-only ESP32-S3 .bin between 288 bytes and 16 MiB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  if (bytes[0] !== 0xe9 || view.getUint32(32, true) !== 0xabcd5432 || view.getUint16(12, true) !== 9) {
    throw new Error("Expected an ESP32-S3 app-only image. Bootloader, partition-table and merged images cannot be uploaded here.");
  }
  const text = (start, end) => new TextDecoder().decode(bytes.slice(start, end)).split("\0")[0];
  const elf = hex(bytes.slice(176, 208));
  if (/^0+$/.test(elf)) throw new Error("The image has no usable ELF identity.");
  return { bytes, elf, project: text(80, 112), version: text(48, 80),
    sha: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) };
}

export function parseInfo(line) {
  const info = Object.fromEntries([...line.matchAll(/\b([a-z_]+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
  if (info.v !== "1" || !/^[01]$/.test(info.active || "") || !/^(?:ota_\d+|factory)$/.test(info.running || "") || !/^[a-f0-9]{64}$/i.test(info.elf || "") ||
      !/^\d+$/.test(info.uptime_ms || "") || !/^\d+$/.test(info.chunk || "") ||
      Number(info.chunk) < 288 || Number(info.chunk) > 512) {
    throw new Error("Unsupported or incomplete CDC OTA identity response.");
  }
  return info;
}

export class CDCOTA {
  constructor(port, log = () => {}) {
    this.port = port;
    this.log = log;
    this.waiter = null;
  }
  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 8192, flowControl: "none" });
    try {
      await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this.closed = false;
      this.readTask = this.readLoop();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async readLoop() {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/^[>\s]+/, "").trim();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith("OTA ")) continue;
          // Data commands can be echoed by the console; never log firmware chunks.
          if (!line.startsWith("OTA ACK ")) this.log(line);
          const pending = this.waiter;
          if (!pending) continue;
          try {
            if (line.startsWith("OTA ERR ")) throw new Error(line);
            if (pending.accept(line)) pending.finish(null, line);
          } catch (error) { pending.finish(error); }
        }
        if (buffer.length > 8192) throw new Error("Serial line exceeded the protocol limit.");
      }
    } catch (error) {
      if (!this.closing) this.readError = error;
    } finally {
      this.closed = true;
      this.reader.releaseLock();
      this.waiter?.finish(this.readError || new Error("Serial device disconnected."));
    }
  }
  async send(command) {
    if (this.closed || !this.writer) throw new Error("Serial port is not connected.");
    let timer;
    try {
      await Promise.race([
        this.writer.write(new TextEncoder().encode(command + "\n")),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Serial write stalled; reconnect before retrying.")), 10000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async exchange(command, accept, timeout = 10000, signal) {
    if (this.waiter) throw new Error("A serial command is already pending.");
    if (signal?.aborted) throw new DOMException("Update cancelled.", "AbortError");
    let pending;
    const reply = new Promise((resolve, reject) => {
      const abort = () => pending.finish(new DOMException("Update cancelled.", "AbortError"));
      const timer = setTimeout(() => pending.finish(new ResponseTimeout("Timed out waiting for the device.")), timeout);
      pending = { accept, finish: (error, line) => {
        if (this.waiter !== pending) return;
        this.waiter = null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(line);
      } };
      this.waiter = pending;
      signal?.addEventListener("abort", abort, { once: true });
    });
    // Attach a rejection handler immediately while a write is in flight.
    reply.catch(() => {});
    try { await this.send(command); } catch (error) { pending.finish(error); }
    return reply;
  }
  async info(signal) {
    return parseInfo(await this.exchange("ota info", line => line.startsWith("OTA INFO "), 5000, signal));
  }
  async upload(image, { signal, progress, stage }) {
    let started = false;
    let ending = false;
    try {
      const info = await this.info(signal);
      if (info.elf.toLowerCase() === image.elf.toLowerCase()) this.log("Selected image matches the currently running ELF; reboot will still be checked.");
      if (info.active !== "0") throw new Error("Another CDC update is active. Disconnect the other updater first.");
      const ready = await this.exchange(`ota begin ${image.bytes.length} ${image.sha}`,
        line => line.startsWith("OTA READY "), 30000, signal);
      started = true;
      const chunk = Number(ready.match(/\bchunk=(\d+)\b/)?.[1]);
      if (!Number.isInteger(chunk) || chunk < 288 || chunk > 512) throw new Error("Invalid negotiated chunk size.");
      stage("uploading");
      for (let offset = 0; offset < image.bytes.length; offset += chunk) {
        const data = image.bytes.subarray(offset, offset + chunk);
        const end = offset + data.length;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.exchange(`ota data ${offset} ${hex(data)}`, line => {
              if (!line.startsWith("OTA ACK ")) return false;
              const ack = Number(line.slice(8));
              if (!Number.isSafeInteger(ack) || ack > end) throw new Error("Device acknowledged an unexpected offset.");
              return ack === end; // Ignore late duplicate ACKs for earlier chunks.
            }, 10000, signal);
            break;
          } catch (error) {
            if (!(error instanceof ResponseTimeout) || attempt === 2) throw error;
            this.log(`Retrying chunk at ${offset} (attempt ${attempt + 2}/3).`);
          }
        }
        progress(end, image.bytes.length);
      }
      if (signal?.aborted) throw new DOMException("Update cancelled.", "AbortError");
      ending = true;
      stage("verifying", info); // Cancellation is disabled once commit may select the next boot slot.
      await this.exchange("ota end", line => line === "OTA OK committed reboot-required", 30000);
      stage("committed");
      return info;
    } catch (error) {
      if (started && !ending && !this.closed) {
        try { await this.exchange("ota abort", line => line === "OTA OK aborted", 3000); }
        catch { /* Disconnect / firmware idle timeout also abort an incomplete transfer. */ }
      }
      if (ending) throw new Error(`Commit outcome is unconfirmed. Reconnect and inspect before retrying. ${error.message}`);
      throw error;
    }
  }
  async close() {
    this.closing = true;
    this.waiter?.finish(new Error("Serial connection closed."));
    // Chromium can leave serial cleanup promises pending after native USB
    // re-enumerates. Bound cleanup so boot verification can reconnect.
    const cleanup = async operation => {
      let timer;
      try {
        await Promise.race([operation(), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
      } catch { /* Already disconnected. */ }
      finally { clearTimeout(timer); }
    };
    await cleanup(() => this.reader?.cancel());
    await cleanup(() => this.readTask);
    await cleanup(() => this.writer?.abort());
    try { this.writer?.releaseLock(); } catch { /* Already released. */ }
    await cleanup(() => this.port.setSignals({ dataTerminalReady: false, requestToSend: false }));
    await cleanup(() => this.port.close());
    this.writer = null;
    this.reader = null;
    this.closed = true;
  }
}

export async function confirmBoot(port, expected, log) {
  // Reuse only the user-selected port. VID/PID matching cannot distinguish two boards.
  await pause(2000);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const check = new CDCOTA(port, log);
    try {
      await check.open();
      const info = await check.info();
      if (info.elf.toLowerCase() === expected.elf &&
          (info.elf.toLowerCase() !== expected.beforeElf || Number(info.uptime_ms) < expected.beforeUptime)) {
        return info;
      }
    } catch { /* Native USB re-enumerates during reboot. */ }
    finally { await check.close(); }
    await pause(1000);
  }
  throw new Error("Image committed, but boot was not confirmed. Reconnect to inspect the running image; do not assume the update succeeded.");
}
