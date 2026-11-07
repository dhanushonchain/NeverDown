const gatewayPill = document.getElementById("gatewayPill");
const ensPill = document.getElementById("ensPill");
const sdkPill = document.getElementById("sdkPill");
const nowPill = document.getElementById("nowPill");
const verdictWithout = document.getElementById("verdictWithout");
const verdictWith = document.getElementById("verdictWith");
const stepsWithout = document.getElementById("stepsWithout");
const stepsWith = document.getElementById("stepsWith");
const delta = document.getElementById("delta");
const detail = document.getElementById("detail");
const evidence = document.getElementById("evidence");
const clearBtn = document.getElementById("clear");

const state = { lastOffer: null, lastPayload: null };

function setBusy(busy) {
  for (const btn of document.querySelectorAll("button[data-action]")) btn.disabled = busy;
}

function setNow(text) {
  if (!nowPill) return;
  nowPill.textContent = text || "idle";
  nowPill.classList.toggle("ok", Boolean(text) && text !== "idle");
  nowPill.classList.toggle("muted", !text || text === "idle");
}

function setVerdict(el, stateName, text) {
  el.dataset.state = stateName;
  el.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function upsertStep(listEl, step) {
  let li = listEl.querySelector(`[data-id="${CSS.escape(step.id)}"]`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.id = step.id;
    listEl.appendChild(li);
  }
  const status = step.status || (step.ok ? "done" : "fail");
  li.className = status;
  const badge =
    status === "running"
      ? `<span class="badge run">working…</span>`
      : status === "done" || step.ok
        ? `<span class="badge ok">done</span>`
        : `<span class="badge fail">fail</span>`;
  const sdk = step.sdkMethod
    ? `<span class="sdk">SDK · ${escapeHtml(step.sdkMethod)}</span>`
    : step.missing
      ? `<span class="miss">${escapeHtml(step.missing)}</span>`
      : "";
  const adds = step.adds ? `<span class="adds">Adds · ${escapeHtml(step.adds)}</span>` : "";
  const timing = step.elapsedMs != null ? `<span class="timing">${step.elapsedMs}ms</span>` : "";
  li.innerHTML = `
    <div class="step-top">${badge}<strong>${escapeHtml(step.title)}</strong>${timing}</div>
    <div class="summary">${escapeHtml(step.detail || (status === "running" ? "in progress…" : ""))}</div>
    ${adds}${sdk}`;
  li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return li;
}

function markDelta(key, on) {
  const li = delta.querySelector(`[data-key="${key}"]`);
  if (!li) return;
  li.classList.toggle("on", on);
  li.classList.toggle("off", !on);
  const label = li.dataset.label || key;
  li.textContent = on ? `${label} — done` : `${label} — missing without SDK`;
}

function showDetail(payload) {
  state.lastPayload = payload;
  detail.hidden = false;
  detail.textContent = JSON.stringify(payload, null, 2);
}

function pushEvidence(href, label) {
  if (!evidence || !href) return;
  evidence.hidden = false;
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  a.textContent = label || href;
  evidence.appendChild(a);
}

async function streamApi(path, { onEvent }) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: "{}",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalPayload = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      onEvent(event);
      if (event.type === "verdict") finalPayload = event;
      if (event.type === "error") throw new Error(event.error || "stream error");
    }
  }
  return finalPayload;
}

async function run(action) {
  setBusy(true);
  const listEl = action === "without" ? stepsWithout : stepsWith;
  const verdictEl = action === "without" ? verdictWithout : verdictWith;
  try {
    if (action === "without") {
      listEl.innerHTML = "";
      setVerdict(verdictEl, "running", "Outage in progress…");
      setNow("Run 1 · without SDK");
      for (const key of ["detect", "ens", "discover", "prove", "deny", "procure", "install"]) {
        markDelta(key, false);
      }
      const data = await streamApi("/api/demo/without", {
        onEvent(event) {
          if (event.type === "step") {
            upsertStep(listEl, event);
            if (event.status === "running") setNow(`Without SDK · ${event.title}`);
          }
        },
      });
      setVerdict(verdictEl, "stuck", data?.verdict || "STUCK");
      showDetail(data);
      setNow("idle");
      return;
    }

    if (action === "with") {
      listEl.innerHTML = "";
      setVerdict(verdictEl, "running", "SDK rails running…");
      setNow("Run 2 · @neverdown/sdk");
      sdkPill.textContent = "@neverdown/sdk live";
      sdkPill.classList.add("ok");
      sdkPill.classList.remove("muted");
      const data = await streamApi("/api/demo/with", {
        onEvent(event) {
          if (event.type === "step") {
            upsertStep(listEl, event);
            if (event.status === "running") setNow(`SDK · ${event.title}`);
          }
          if (event.type === "improve") {
            markDelta(event.key, true);
            if (event.ensName) {
              ensPill.textContent = event.ensName;
              ensPill.classList.add("ok");
            }
            if (event.offer) state.lastOffer = event.offer;
          }
        },
      });
      if (data?.offer) state.lastOffer = data.offer;
      setVerdict(verdictEl, data?.recovered ? "recovered" : "stuck", data?.verdict || "done");
      showDetail(data);
      setNow("idle — click Live procure for pay + install");
      return;
    }

    if (action === "procure") {
      setVerdict(verdictEl, "running", "Procure + install in progress…");
      setNow("Procure · payment worker + gateway install");
      if (evidence) {
        evidence.hidden = true;
        evidence.innerHTML = "<span>Evidence</span>";
      }
      const data = await streamApi("/api/procure", {
        onEvent(event) {
          if (event.type === "step") {
            upsertStep(listEl, event);
            if (event.status === "running") setNow(`Procure · ${event.title}`);
          }
          if (event.type === "progress") setNow(event.message);
          if (event.type === "improve") markDelta(event.key, true);
          if (event.type === "link") pushEvidence(event.href, event.label);
        },
      });
      if (data?.offer) state.lastOffer = data.offer;
      const ok = Boolean(data?.recovered);
      setVerdict(
        verdictEl,
        ok ? "recovered" : "stuck",
        data?.verdict || (ok ? "RECOVERED" : "Procure incomplete"),
      );
      if (data?.receipt?.hashscanUrl) pushEvidence(data.receipt.hashscanUrl, "HashScan (receipt)");
      if (data?.gatewayAfter?.ready?.ready) {
        gatewayPill.textContent = `gateway ready · ${data.gatewayAfter.status.active}`;
        gatewayPill.classList.add("ok");
      }
      showDetail(data);
      setNow(ok ? "Recovered · standby installed" : "idle");
      return;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setVerdict(verdictEl, "stuck", msg);
    showDetail({ error: msg });
    setNow("idle");
  } finally {
    setBusy(false);
  }
}

clearBtn.addEventListener("click", () => {
  stepsWithout.innerHTML = "";
  stepsWith.innerHTML = "";
  setVerdict(verdictWithout, "idle", "Waiting…");
  setVerdict(verdictWith, "idle", "Waiting…");
  detail.hidden = true;
  detail.textContent = "";
  if (evidence) {
    evidence.hidden = true;
    evidence.innerHTML = "<span>Evidence</span>";
  }
  setNow("idle");
  for (const li of delta.querySelectorAll("li")) {
    li.classList.remove("on", "off");
    li.textContent = `${li.dataset.label} — not yet`;
  }
});

for (const btn of document.querySelectorAll("button[data-action]")) {
  btn.addEventListener("click", () => run(btn.dataset.action));
}

fetch("/api/bootstrap")
  .then((r) => r.json())
  .then((data) => {
    gatewayPill.textContent = data.gateway?.ready?.ready ? `gateway ready · ${data.gateway.status.active}` : "gateway down";
    gatewayPill.classList.toggle("ok", !!data.gateway?.ready?.ready);
    gatewayPill.classList.toggle("bad", !data.gateway?.ready?.ready);
    ensPill.textContent = data.ensName || "ENS unset";
    sdkPill.textContent = data.sdkPackage || "@neverdown/sdk";
    sdkPill.classList.add("ok");
    setNow("idle");
  })
  .catch((error) => {
    gatewayPill.textContent = "gateway unknown";
    gatewayPill.classList.add("bad");
    showDetail({ error: error.message });
  });
