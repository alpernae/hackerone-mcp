#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const H1_API_BASE = "https://api.hackerone.com/v1";

const DEFAULT_TIMEOUT_MS = Number.parseInt(
  process.env.HACKERONE_TIMEOUT_MS ?? process.env.H1_TIMEOUT_MS ?? "20000",
  10
);
const DEFAULT_MAX_RETRIES = Number.parseInt(
  process.env.HACKERONE_MAX_RETRIES ?? process.env.H1_MAX_RETRIES ?? "2",
  10
);
const DEFAULT_RETRY_BASE_DELAY_MS = Number.parseInt(
  process.env.HACKERONE_RETRY_BASE_DELAY_MS ?? "400",
  10
);
const DEFAULT_RETRY_MAX_DELAY_MS = Number.parseInt(
  process.env.HACKERONE_RETRY_MAX_DELAY_MS ?? "4000",
  10
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function getTimeoutMs() {
  return clampNumber(DEFAULT_TIMEOUT_MS, 1000, 120000);
}

function getMaxRetries() {
  return clampNumber(DEFAULT_MAX_RETRIES, 0, 6);
}

function truncateText(text, maxLen) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n…(truncated ${text.length - maxLen} chars)`;
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Numeric seconds per RFC 9110.
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  // HTTP date.
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function isRetryableStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isRetryableFetchError(err) {
  // Node fetch typically throws TypeError('fetch failed') with a nested cause.
  const name = err?.name;
  if (name === "AbortError") return true;

  const code = err?.cause?.code ?? err?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  );
}

function computeBackoffDelayMs(attempt) {
  const base = clampNumber(DEFAULT_RETRY_BASE_DELAY_MS, 50, 30000);
  const max = clampNumber(DEFAULT_RETRY_MAX_DELAY_MS, base, 60000);
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = Math.floor(Math.random() * Math.min(250, exp));
  return Math.min(max, exp + jitter);
}

function getHeader(headers, name) {
  if (!headers) return null;
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return null;
}

function formatH1HttpError({ status, url, body, headers }) {
  const requestId =
    getHeader(headers, "x-request-id") ??
    getHeader(headers, "x-amzn-requestid") ??
    getHeader(headers, "x-amz-request-id");
  const retryAfter = getHeader(headers, "retry-after");

  const parts = [`HackerOne API error ${status}`];
  if (url) parts.push(url);
  if (requestId) parts.push(`request_id=${requestId}`);
  if (retryAfter) parts.push(`retry_after=${retryAfter}`);

  const prefix = parts.join(" | ");
  const bodySnippet = truncateText(body, 3000);
  return bodySnippet ? `${prefix}\n${bodySnippet}` : prefix;
}

function normalizeCredential(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();

  // Tolerate quoted env values from JSON/yaml configs.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function getAuth() {
  const username = normalizeCredential(
    process.env.HACKERONE_API_USERNAME ?? process.env.HACKERONE_USERNAME
  );
  const token = normalizeCredential(process.env.HACKERONE_API_TOKEN);

  if (!username || !token) {
    throw new Error(
      "Missing HACKERONE_API_USERNAME (or HACKERONE_USERNAME) and HACKERONE_API_TOKEN environment variables"
    );
  }

  return Buffer.from(`${username}:${token}`).toString("base64");
}

async function h1Request(path, params = {}) {
  const url = new URL(`${H1_API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const maxRetries = getMaxRetries();
  const timeoutMs = getTimeoutMs();
  const urlString = url.toString();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(urlString, {
        headers: {
          Authorization: `Basic ${getAuth()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "hackerone-mcp/1.0.0",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);

      const canRetry = attempt < maxRetries && isRetryableFetchError(err);
      if (canRetry) {
        const delayMs = computeBackoffDelayMs(attempt);
        await sleep(delayMs);
        continue;
      }

      const msg = err?.message ? String(err.message) : String(err);
      throw new Error(
        `HackerOne API request failed${
          attempt ? ` (after ${attempt + 1} attempts)` : ""
        }: ${msg}`
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.ok) {
      return res.json();
    }

    const bodyText = await res.text();
    const shouldRetry = attempt < maxRetries && isRetryableStatus(res.status);

    if (res.status === 401) {
      throw new Error(
        "HackerOne API error 401: Unauthorized. Verify the MCP process is using the same HACKERONE_API_USERNAME (or HACKERONE_USERNAME) and HACKERONE_API_TOKEN as your curl command. HackerOne expects the API token identifier as the username. Restart the MCP client after credential updates."
      );
    }

    if (shouldRetry) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const delayMs =
        retryAfterMs !== null
          ? clampNumber(retryAfterMs, 0, 10000)
          : computeBackoffDelayMs(attempt);
      await sleep(delayMs);
      continue;
    }

    throw new Error(
      formatH1HttpError({
        status: res.status,
        url: urlString,
        body: bodyText,
        headers: res.headers,
      })
    );
  }

  throw new Error("HackerOne API request failed: exhausted retries");
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  // Reports
  {
    name: "h1_list_reports",
    description:
      "List your HackerOne reports. Filter by program, state, severity, etc.",
    inputSchema: {
      type: "object",
      properties: {
        program_handle: {
          type: "string",
          description: "Filter by program handle (e.g. 'nodejs')",
        },
        state: {
          type: "string",
          enum: [
            "new",
            "triaged",
            "needs-more-info",
            "resolved",
            "informative",
            "not-applicable",
            "duplicate",
            "spam",
          ],
          description: "Filter by report state",
        },
        severity: {
          type: "string",
          enum: ["none", "low", "medium", "high", "critical"],
          description: "Filter by severity rating",
        },
        page_number: {
          type: "number",
          description: "Page number (default: 1)",
        },
        page_size: {
          type: "number",
          description: "Results per page, max 100 (default: 25)",
        },
        sort: {
          type: "string",
          description:
            "Sort field and direction, e.g. 'created_at:desc' or 'severity_rating:desc'",
        },
      },
    },
  },
  {
    name: "h1_get_report",
    description: "Get full details of a specific HackerOne report by ID.",
    inputSchema: {
      type: "object",
      required: ["report_id"],
      properties: {
        report_id: {
          type: "string",
          description: "The numeric report ID",
        },
      },
    },
  },
  // Program scopes
  {
    name: "h1_get_program_scopes",
    description:
      "Get the in-scope and out-of-scope assets (structured scope) for a HackerOne program.",
    inputSchema: {
      type: "object",
      required: ["program_handle"],
      properties: {
        program_handle: {
          type: "string",
          description: "The program handle (e.g. 'nodejs', 'security')",
        },
      },
    },
  },
  // Program details
  {
    name: "h1_get_program",
    description:
      "Get details of a HackerOne program: policy, rewards, response targets, etc.",
    inputSchema: {
      type: "object",
      required: ["program_handle"],
      properties: {
        program_handle: {
          type: "string",
          description: "The program handle (e.g. 'nodejs')",
        },
      },
    },
  },
  {
    name: "h1_list_programs",
    description:
      "List HackerOne programs you have access to (as a hacker or member).",
    inputSchema: {
      type: "object",
      properties: {
        page_number: { type: "number", description: "Page number (default: 1)" },
        page_size: {
          type: "number",
          description: "Results per page (default: 25)",
        },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleListReports(args) {
  const params = {};
  if (args.program_handle)
    params["filter[program][]"] = args.program_handle;
  if (args.state) params["filter[state][]"] = args.state;
  if (args.severity) params["filter[severity_rating][]"] = args.severity;
  if (args.page_number) params["page[number]"] = args.page_number;
  if (args.page_size) params["page[size]"] = Math.min(args.page_size, 100);
  if (args.sort) params["sort"] = args.sort;

  const data = await h1Request("/hackers/me/reports", params);

  const reports = (data.data || []).map((r) => ({
    id: r.id,
    title: r.attributes?.title,
    state: r.attributes?.state,
    severity: r.attributes?.severity_rating,
    created_at: r.attributes?.created_at,
    bounty_awarded: r.attributes?.bounty_awarded_at ? "yes" : "no",
    program: r.relationships?.program?.data?.id || "N/A",
    url: `https://hackerone.com/reports/${r.id}`,
  }));

  return {
    total: data.meta?.total_count ?? reports.length,
    page: data.meta?.current_page ?? 1,
    reports,
  };
}

async function handleGetReport(args) {
  const data = await h1Request(`/hackers/reports/${args.report_id}`);
  const r = data.data;
  const attrs = r.attributes || {};

  return {
    id: r.id,
    title: attrs.title,
    state: attrs.state,
    severity: attrs.severity_rating,
    vulnerability_info: attrs.vulnerability_information,
    impact: attrs.impact,
    bounty_awarded: attrs.bounty_awarded_at || null,
    created_at: attrs.created_at,
    triaged_at: attrs.triaged_at,
    closed_at: attrs.closed_at,
    url: `https://hackerone.com/reports/${r.id}`,
    weakness: r.relationships?.weakness?.data?.id || null,
    assignee: r.relationships?.assignee?.data?.id || null,
  };
}

async function handleGetProgramScopes(args) {
  const data = await h1Request(
    `/hackers/programs/${args.program_handle}/structured_scopes`
  );

  const scopes = (data.data || []).map((s) => ({
    id: s.id,
    asset_type: s.attributes?.asset_type,
    asset_identifier: s.attributes?.asset_identifier,
    eligible_for_bounty: s.attributes?.eligible_for_bounty,
    eligible_for_submission: s.attributes?.eligible_for_submission,
    instruction: s.attributes?.instruction || null,
    max_severity: s.attributes?.max_severity || null,
  }));

  const inScope = scopes.filter((s) => s.eligible_for_submission !== false);
  const outOfScope = scopes.filter(
    (s) => s.eligible_for_submission === false
  );

  return {
    program: args.program_handle,
    total_assets: scopes.length,
    in_scope: inScope,
    out_of_scope: outOfScope,
  };
}

async function handleGetProgram(args) {
  const data = await h1Request(`/hackers/programs/${args.program_handle}`);
  const p = data.data;
  const attrs = p.attributes || {};

  return {
    id: p.id,
    handle: attrs.handle,
    name: attrs.name,
    state: attrs.state,
    offers_bounties: attrs.offers_bounties,
    offers_swag: attrs.offers_swag,
    submission_state: attrs.submission_state,
    policy: attrs.policy,
    profile_picture: attrs.profile_picture,
    url: `https://hackerone.com/${attrs.handle}`,
    response_efficiency: attrs.response_efficiency_percentage,
    disclosed_reports: attrs.number_of_reports_for_user,
  };
}

async function handleListPrograms(args) {
  const params = {};
  if (args.page_number) params["page[number]"] = args.page_number;
  if (args.page_size) params["page[size]"] = args.page_size;

  const data = await h1Request("/hackers/programs", params);

  const programs = (data.data || []).map((p) => ({
    id: p.id,
    handle: p.attributes?.handle,
    name: p.attributes?.name,
    state: p.attributes?.state,
    offers_bounties: p.attributes?.offers_bounties,
    submission_state: p.attributes?.submission_state,
    url: `https://hackerone.com/${p.attributes?.handle}`,
  }));

  return {
    total: data.meta?.total_count ?? programs.length,
    programs,
  };
}

// ── MCP Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: "hackerone-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    let result;

    switch (name) {
      case "h1_list_reports":
        result = await handleListReports(args || {});
        break;
      case "h1_get_report":
        result = await handleGetReport(args);
        break;
      case "h1_get_program_scopes":
        result = await handleGetProgramScopes(args);
        break;
      case "h1_get_program":
        result = await handleGetProgram(args);
        break;
      case "h1_list_programs":
        result = await handleListPrograms(args || {});
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("HackerOne MCP server running...");
