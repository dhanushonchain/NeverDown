import type { ServerResponse } from "node:http";
import { getGatewayStatus } from "../../../packages/sdk/src/status.js";
import { policySnapshot } from "./policyDemo.js";

const THINK_MS = Math.max(450, Number(process.env.AGENT_CHAT_STEP_MS ?? 850));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Intent =
  | "why"
  | "status"
  | "policy"
  | "evidence"
  | "recover"
  | "procure"
  | "deny"
  | "sdk"
  | "demo"
  | "help"
  | "general";

function classify(question: string): Intent {
  const text = question.toLowerCase().replace(/[’']/g, "'");

  // Product need / value — catch messy phrasing like "what is need of neverdown"
  if (
    /\b(why|need|needed|necessity|problem|pain|use[- ]?case|value|point|purpose|benefit|useful|important)\b/.test(text) ||
    /what('s| is| are)?\s+(the\s+)?(need|point|purpose|use)/.test(text) ||
    /why\s+(do\s+we\s+|we\s+)?(need|use|want)/.test(text) ||
    /need of neverdown|neverdown for|without neverdown/.test(text)
  ) {
    return "why";
  }

  if (/status|health|online|active|upstream|gateway|provider|latency|healthy/.test(text)) return "status";
  if (/evidence|proof|receipt|hashscan|transaction|audit|hcs|topic|arkiv entity/.test(text)) return "evidence";
  if (/recover|failover|standby|failure|outage|fast plane|primary|switch|downtime/.test(text)) return "recover";
  if (/policy|contract|budget|allowlist|cap|allowed|tinybars|refuse before sign|deny bad seller/.test(text)) return "policy";
  if (/deny|denied|attack|unsafe|reject|spoof|bad seller|bad recipient|guardrail/.test(text)) return "deny";
  if (/procure|purchase|pay|seller|offer|arkiv|ens|install|settle|x402|hbar/.test(text)) return "procure";
  if (/\bsdk\b|npm|package|@neverdown|consumer|integrate|import \{/.test(text)) return "sdk";
  if (/demo|console|act\s*[1-5]|how (do|to) (i |we )?(start|show|run)|judge|pitch/.test(text)) return "demo";
  if (
    /hello|hi\b|hey\b|help|what is neverdown|what's neverdown|who are you|how does it work|explain neverdown|tell me about/.test(
      text,
    )
  ) {
    return "help";
  }
  if (/neverdown/.test(text)) return "help";
  return "general";
}

function beginStream(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  const write = (event: Record<string, unknown>) => {
    res.write(`${JSON.stringify(event)}\n`);
  };
  return {
    async think(text: string) {
      write({ type: "think", text });
      await sleep(THINK_MS);
    },
    answer(text: string) {
      write({ type: "answer", text });
    },
    done(extra: Record<string, unknown> = {}) {
      write({ type: "done", ...extra });
      res.end();
    },
    error(message: string) {
      write({ type: "error", error: message });
      res.end();
    },
  };
}

async function liveStatus(gatewayUrl: string) {
  try {
    const { ready, status } = await getGatewayStatus(gatewayUrl);
    const providers = Array.isArray(status.providers)
      ? status.providers.map((p) => `${p.id}: ${p.healthy ? "healthy" : "unhealthy"}`).join(" · ")
      : "no provider detail";
    return {
      ok: Boolean(ready?.ready),
      line: `Active route: ${status.active || "unknown"}. ${providers}. Redundancy=${Boolean(status.redundancy)}.`,
    };
  } catch (error) {
    return {
      ok: false,
      line: `Gateway unreachable (${error instanceof Error ? error.message : "error"}). Start pnpm gateway:live.`,
    };
  }
}

function evidenceLine(env: NodeJS.ProcessEnv) {
  return `Evidence board: ENS ${env.SELLER_ENS_NAME || "neverdownseller.eth"}; Arkiv ${env.DEMO_ARKIV_ENTITY_KEY || "0x7486…310d"}; tx ${env.DEMO_HEDERA_TX_ID || "0.0.9185802@…"}. Open Act 5 for HashScan.`;
}

const WHY_ANSWER =
  "You need NeverDown when a critical dependency can fail (RPC, indexer, price API, …) and a human pager is too slow. " +
  "Without it: hard-coded retries on a dead URL → stuck. " +
  "With it: a Resilience Contract bounds spend (allowlist / caps / budget), the fast plane fails over to a preapproved standby immediately, " +
  "then the procurement plane discovers → verifies (ENS + capability) → pays only if policy allows → installs replacement capacity, with HashScan/HCS evidence. " +
  "RPC is only the hackathon demo vertical — the product is programmable resilience for any failure spot.";

const HELP_ANSWER =
  "NeverDown is a programmable resilience operator. " +
  "Act 1 writes the spend boundary; Act 2 shows live failover; Act 3 procures capacity; Act 4 proves deny-before-sign; Act 5 opens evidence. " +
  "Ask me why you need it, how recovery works, what policy blocks, or for live status.";

export async function streamAgentChat(input: {
  res: ServerResponse;
  question: string;
  gatewayUrl: string;
  root: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const stream = beginStream(input.res);
  const question = input.question.trim().slice(0, 500);
  if (!question) {
    stream.error("Empty question");
    return;
  }

  const intent = classify(question);
  try {
    await stream.think("Understanding what you asked…");
    await stream.think(`Matched topic → ${intent}`);

    if (intent === "why") {
      await stream.think("Framing the failure-spot problem NeverDown solves…");
      await stream.think("Contrast: stuck retries vs contract + fast plane + procurement.");
      stream.answer(WHY_ANSWER);
      stream.done({ intent });
      return;
    }

    if (intent === "status") {
      await stream.think("Checking gateway health and active route…");
      const status = await liveStatus(input.gatewayUrl);
      await stream.think(status.ok ? "Gateway responded with live providers." : "Gateway check failed.");
      stream.answer(`${status.line} Same data as Act 2 — Refresh status there for the full provider cards.`);
      stream.done({ intent });
      return;
    }

    if (intent === "policy") {
      await stream.think("Loading live Resilience Contract bounds…");
      const snap = policySnapshot(env, input.root);
      await stream.think(`Spent ${snap.alreadySpentTinybars} / budget ${snap.totalBudgetTinybars} tinybars.`);
      stream.answer(
        `Your contract right now: allowlist [${snap.allowlist.join(", ")}], max ${snap.maxPaymentTinybars} tinybars per payment, total budget ${snap.totalBudgetTinybars} (remaining ${snap.remainingTinybars}). ` +
          `Any purchase outside those bounds is refused before sign — no Hedera tx. On Act 1 try “Deny bad seller” or “Deny over budget” to see the gates fire.`,
      );
      stream.done({ intent, policy: snap });
      return;
    }

    if (intent === "evidence") {
      await stream.think("Collecting what judges can verify on-chain / on Arkiv…");
      await sleep(THINK_MS);
      stream.answer(
        `${evidenceLine(env)} Topic ${env.HEDERA_TOPIC_ID || "(set HEDERA_TOPIC_ID)"}. Act 5 lists clickable proof links.`,
      );
      stream.done({ intent });
      return;
    }

    if (intent === "recover") {
      await stream.think("Explaining fast plane vs procurement plane…");
      const status = await liveStatus(input.gatewayUrl);
      await stream.think("Fast plane never waits for ENS, Arkiv, or payment.");
      stream.answer(
        `Recovery starts on the fast plane: the gateway probes primary + standby and fails over immediately if primary dies — no agent, no LLM, no payment. ` +
          `Live now: ${status.line} ` +
          `After traffic is safe, Acts 3–4 replenish capacity under the Resilience Contract (discover → prove → pay only if allowed → install).`,
      );
      stream.done({ intent });
      return;
    }

    if (intent === "procure") {
      await stream.think("Walking the procurement loop…");
      await stream.think("discover → ENS → prove → authorize → settle → install");
      stream.answer(
        "Procurement replenishes capacity after failover. Flow: discover Arkiv offers → resolve seller ENS → prove capability → policy authorize → payment worker settles (x402/Hedera) → gateway installs standby. " +
          "Act 3 default is hermetic (no HBAR). Live settle needs AGENT_LIVE=true. Act 1 can preview approve/deny without spending.",
      );
      stream.done({ intent });
      return;
    }

    if (intent === "deny") {
      await stream.think("Guardrail: bad payTo must never reach settle…");
      stream.answer(
        "Denial is the safety story. Act 1 “Deny bad seller” shows allowlist fail-closed instantly. Act 4 runs the full agent path against a spoofed recipient and should return RECIPIENT_NOT_ALLOWLISTED with nothing signed. Same idea for over-budget: refuse before sign.",
      );
      stream.done({ intent });
      return;
    }

    if (intent === "sdk") {
      await stream.think("Separating product console from the SDK consumer…");
      stream.answer(
        "Apps integrate with `@neverdown/sdk` on the server (never in the browser with spend keys): FailureSpotMonitor detects incidents; NeverDown.resolveSeller / discoverOffers / proveCapability / procure handle the rails. " +
          "This console is the operator demo. The separate example UI on :3100 shows the same failure without SDK (stuck) vs with SDK (recoverable).",
      );
      stream.done({ intent });
      return;
    }

    if (intent === "demo") {
      await stream.think("Mapping the judge click-path…");
      stream.answer(
        "Demo path: Act 1 deny bad seller → Act 2 refresh status (primary+standby healthy) → Act 3 hermetic procure → Act 4 denial attack → Act 5 open HashScan/ENS. " +
          "For live settle evidence keep gateway:live + worker env funded. Ask “why NeverDown” if you need the pitch line first.",
      );
      stream.done({ intent });
      return;
    }

    if (intent === "help") {
      await stream.think("Giving the short product frame…");
      stream.answer(HELP_ANSWER);
      stream.done({ intent });
      return;
    }

    // Soft fallback: still answer usefully from any weak signal instead of a dead-end.
    await stream.think("No narrow tool hit — answering with the core NeverDown pitch…");
    stream.answer(
      `${WHY_ANSWER}\n\nYou asked: “${question}”. If you want a specific rail next, ask about status, policy, recovery, procurement, denial, evidence, SDK, or the demo path.`,
    );
    stream.done({ intent: "general" });
  } catch (error) {
    stream.error(error instanceof Error ? error.message : String(error));
  }
}
