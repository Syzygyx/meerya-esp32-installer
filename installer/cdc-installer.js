import { CDCOTA, inspectImage, confirmBoot } from "./cdc-ota.js";

const $ = id => document.getElementById(id);
let connection, image, info, busy = false, controller, stage = "idle";
let pendingBoot = null;
try { pendingBoot = JSON.parse(sessionStorage.getItem("meerya-cdc-pending-boot") || "null"); } catch { /* Optional session recovery. */ }
function remember(value) {
  pendingBoot = value;
  try {
    if (value) sessionStorage.setItem("meerya-cdc-pending-boot", JSON.stringify(value));
    else sessionStorage.removeItem("meerya-cdc-pending-boot");
  } catch { /* Serial operation does not depend on browser storage. */ }
}
function log(text) { $("log").textContent = ($("log").textContent + text + "\n").slice(-24000); }
function status(text, error = false) { $("status").textContent = text; $("status").dataset.error = String(error); }
function controls() {
  const connected = connection && !connection.closed && info;
  $("connect").disabled = busy || !!connected || !navigator.serial || !isSecureContext;
  $("disconnect").disabled = busy || !connection;
  $("file").disabled = busy;
  $("compatible").disabled = busy;
  $("reboot").disabled = busy;
  $("update").disabled = busy || !connected || !image || !$("compatible").checked || info.active !== "0" || !!pendingBoot;
  $("cancel").disabled = !busy || stage !== "uploading";
}
function showDevice(value) {
  $("device").textContent = `CDC OTA v${value.v} · Running: ${value.running}\nELF: ${value.elf}\nUptime: ${value.uptime_ms} ms · Transfer active: ${value.active}`;
}
function checkPending(value) {
  if (!pendingBoot) return false;
  if (value.elf.toLowerCase() === pendingBoot.elf &&
      (value.elf.toLowerCase() !== pendingBoot.beforeElf || Number(value.uptime_ms) < pendingBoot.beforeUptime)) {
    remember(null);
    status("Boot confirmed: the selected firmware is running.");
  } else {
    status("An update was committed, but its boot is not confirmed. Reboot the device, then reconnect and inspect.", true);
  }
  return true;
}

$("connect").addEventListener("click", async () => {
  busy = true; controls();
  try {
    if (connection) await connection.close();
    // Leave the chooser unfiltered: the firmware handshake is the authority.
    const port = await navigator.serial.requestPort();
    connection = new CDCOTA(port, log);
    await connection.open();
    info = await connection.info();
    showDevice(info);
    if (!checkPending(info)) status(info.active === "0" ? "Connected. Choose a compatible app image." : "Another CDC upload is active.", info.active !== "0");
  } catch (error) {
    await connection?.close(); connection = null; info = null;
    status(`${error.message} Use native CDC with OTA v1 firmware; close other serial tools.`, true);
  } finally { busy = false; controls(); }
});
$("disconnect").addEventListener("click", async () => {
  busy = true; controls();
  try { await connection?.close(); }
  finally { connection = null; info = null; busy = false; $("device").textContent = "No device connected."; status("Disconnected."); controls(); }
});
let fileGeneration = 0;
$("file").addEventListener("change", async () => {
  const generation = ++fileGeneration;
  image = null; $("compatible").checked = false; controls();
  const file = $("file").files[0];
  if (!file) { $("image").textContent = "No firmware selected."; return; }
  $("image").textContent = "Reading image and calculating SHA-256…";
  try {
    const selected = await inspectImage(file);
    if (generation !== fileGeneration) return;
    image = selected;
    $("image").textContent = `${file.name} · ${image.bytes.length.toLocaleString()} bytes\nProject: ${image.project} · Version: ${image.version}\nSHA-256: ${image.sha}\nELF: ${image.elf}`;
  } catch (error) { if (generation === fileGeneration) $("image").textContent = error.message; }
  controls();
});
$("compatible").addEventListener("change", controls);
$("cancel").addEventListener("click", () => controller?.abort());
$("update").addEventListener("click", async () => {
  busy = true; stage = "uploading"; controller = new AbortController(); controls();
  $("progress").value = 0;
  const selected = image;
  const reboot = $("reboot").checked;
  try {
    status("Uploading to the inactive app slot…");
    const before = await connection.upload(selected, {
      signal: controller.signal,
      stage: (value, before) => {
        stage = value;
        // Persist before sending commit: a lost acknowledgment must also block a blind retry.
        if (value === "verifying") {
          remember({ elf: selected.elf, beforeElf: before.elf.toLowerCase(), beforeUptime: Number(before.uptime_ms) });
          status("Verifying firmware and selecting the next boot image…");
        }
        controls();
      },
      progress: (done, total) => { $("progress").value = done * 100 / total; status(`Uploading: ${Math.floor(done * 100 / total)}% (${done.toLocaleString()} / ${total.toLocaleString()} bytes)`); }
    });
    // Refresh uptime after the upload, matching the command-line uploader's boot check.
    remember({ elf: selected.elf, beforeElf: before.elf.toLowerCase(), beforeUptime: Number(before.uptime_ms) });
    if (!reboot) {
      status("Image verified and committed. Reboot when ready; boot has not been confirmed.");
      await connection.close(); connection = null; info = null;
      return;
    }
    const current = await connection.info();
    remember({ ...pendingBoot, beforeUptime: Number(current.uptime_ms) });
    status("Image committed. Rebooting and checking the running ELF identity…");
    const port = connection.port;
    await connection.send("reboot");
    await connection.close(); connection = null; info = null;
    const booted = await confirmBoot(port, pendingBoot, log);
    showDevice(booted); remember(null);
    status("Update complete. Boot confirmed: the selected firmware is running.");
  } catch (error) {
    const prefix = stage === "committed" ? "Image committed; boot not confirmed. " : "";
    status(prefix + (error.name === "AbortError" ? "Upload cancelled. Reconnect before starting another update." : error.message), true);
    log(error.message);
  } finally {
    await connection?.close(); connection = null; info = null;
    busy = false; controller = null; stage = "idle"; controls();
  }
});
navigator.serial?.addEventListener("disconnect", event => {
  if (!busy && connection && (event.target === connection.port || event.port === connection.port)) {
    info = null; status("Device disconnected. Reconnect to inspect it.", true); controls();
  }
});
window.addEventListener("beforeunload", event => { if (busy) { event.preventDefault(); event.returnValue = ""; } });
if (!isSecureContext || !navigator.serial) status("Open this page in desktop Chrome or Edge using HTTPS or localhost to use Web Serial.", true);
else if (pendingBoot) status("A previous update needs boot confirmation. Connect and inspect the device.");
controls();
