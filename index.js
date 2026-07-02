#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.HACKERONE_API_BASE ?? "https://api.hackerone.com/v1";
const TIMEOUT = Math.min(Math.max(Number(process.env.HACKERONE_TIMEOUT_MS ?? 20000), 1000), 120000);
const RETRIES = Math.min(Math.max(Number(process.env.HACKERONE_MAX_RETRIES ?? 2), 0), 6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const part = (value) => encodeURIComponent(String(value));

function auth() {
  const username = (process.env.HACKERONE_API_USERNAME ?? process.env.HACKERONE_USERNAME ?? "").trim();
  const token = (process.env.HACKERONE_API_TOKEN ?? process.env.H1_API_TOKEN ?? "").trim();
  if (!username || !token) throw new Error("Set HACKERONE_API_USERNAME and HACKERONE_API_TOKEN");
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

function pages(args) {
  return {
    "page[number]": args.page_number,
    "page[size]": args.page_size === undefined ? undefined : Math.min(args.page_size, 100),
  };
}

async function api(path, { method = "GET", params = {}, body, form } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const headers = { Authorization: auth(), Accept: "application/json", "User-Agent": "hackerone-mcp/2.0.0" };
      let payload = form;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : { success: true, status: response.status };
      if (attempt < RETRIES && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10000) : 400 * 2 ** attempt);
        continue;
      }
      throw new Error(`HackerOne API ${response.status}: ${text.slice(0, 3000)}`);
    } catch (error) {
      if (attempt < RETRIES && (error.name === "AbortError" || error instanceof TypeError)) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

const pagination = {
  page_number: { type: "integer", minimum: 1 },
  page_size: { type: "integer", minimum: 1, maximum: 100 },
};
const id = (description) => ({ type: "string", minLength: 1, description });
const tool = (name, description, properties = {}, required = []) => ({
  name, description,
  inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
});
const program = { program_handle: id("Program handle") };
const intent = { intent_id: id("Report intent ID") };

const TOOLS = [
  tool("h1_get_hacktivity", "Search public Hacktivity reports using Lucene syntax.", {
    query: { type: "string", description: "queryString filters: severity_rating, asset_type, substate, cwe, cve_ids, reporter, team, total_awarded_amount, disclosed_at, has_collaboration, disclosed" },
    sort: { type: "string", enum: ["latest_disclosable_activity_at", "-latest_disclosable_activity_at", "disclosed_at", "-disclosed_at", "total_awarded_amount", "-total_awarded_amount", "votes", "-votes"] }, ...pagination,
  }),
  tool("h1_list_reports", "List reports owned by the authenticated hacker.", pagination),
  tool("h1_get_report", "Get a report with its relationships.", { report_id: id("Report ID") }, ["report_id"]),
  tool("h1_create_report", "Submit a vulnerability report.", {
    team_handle: id("Program handle"), title: id("Title"), vulnerability_information: id("Description and reproduction steps"),
    impact: id("Security impact"), severity_rating: { type: "string", enum: ["none", "low", "medium", "high", "critical"] },
    weakness_id: { type: "integer", minimum: 1 }, structured_scope_id: { type: "integer", minimum: 1 },
  }, ["team_handle", "title", "vulnerability_information", "impact", "weakness_id"]),
  tool("h1_get_balance", "Get the authenticated hacker's payment balance."),
  tool("h1_get_earnings", "List earnings.", pagination),
  tool("h1_get_payouts", "List payouts.", pagination),
  tool("h1_list_programs", "List available programs.", pagination),
  tool("h1_get_program", "Get program details.", program, ["program_handle"]),
  tool("h1_get_program_scopes", "List structured scopes.", {
    ...program, id_greater_than: { type: "integer", minimum: 0 }, created_after: { type: "string", format: "date-time" },
    updated_after: { type: "string", format: "date-time" }, ...pagination,
  }, ["program_handle"]),
  tool("h1_get_scope_exclusions", "List excluded report categories.", program, ["program_handle"]),
  tool("h1_get_program_weaknesses", "List accepted weaknesses.", { ...program, ...pagination }, ["program_handle"]),
  tool("h1_list_report_intents", "List report intents.", pagination),
  tool("h1_get_report_intent", "Get a report intent and pipeline status.", intent, ["intent_id"]),
  tool("h1_create_report_intent", "Create an AI-assisted report intent.", { team_handle: id("Program handle"), description: id("Vulnerability details") }, ["team_handle", "description"]),
  tool("h1_update_report_intent", "Update an unsubmitted report intent.", { ...intent, description: id("Vulnerability details") }, ["intent_id", "description"]),
  tool("h1_delete_report_intent", "Permanently delete an unsubmitted report intent.", intent, ["intent_id"]),
  tool("h1_submit_report_intent", "Submit a ready report intent.", intent, ["intent_id"]),
  tool("h1_list_report_intent_attachments", "List report intent attachments.", intent, ["intent_id"]),
  tool("h1_upload_report_intent_attachments", "Upload local files to an unsubmitted report intent.", {
    ...intent, file_paths: { type: "array", minItems: 1, maxItems: 10, items: id("Local file path") },
  }, ["intent_id", "file_paths"]),
  tool("h1_delete_report_intent_attachment", "Permanently delete a report intent attachment.", {
    ...intent, attachment_id: id("Attachment ID"),
  }, ["intent_id", "attachment_id"]),
];

const document = (type, attributes) => ({ data: { type, attributes } });

async function upload(args) {
  const form = new FormData();
  for (const filePath of args.file_paths) {
    form.append("files[]", new Blob([await readFile(filePath)]), basename(filePath));
  }
  return api(`/hackers/report_intents/${part(args.intent_id)}/attachments`, { method: "POST", form });
}

async function invoke(name, args) {
  const handle = part(args.program_handle);
  const intentId = part(args.intent_id);
  switch (name) {
    case "h1_get_hacktivity": return api("/hackers/hacktivity", { params: { queryString: args.query, sort: args.sort, ...pages(args) } });
    case "h1_list_reports": return api("/hackers/me/reports", { params: pages(args) });
    case "h1_get_report": return api(`/hackers/reports/${part(args.report_id)}`);
    case "h1_create_report": return api("/hackers/reports", { method: "POST", body: document("report", args) });
    case "h1_get_balance": return api("/hackers/payments/balance");
    case "h1_get_earnings": return api("/hackers/payments/earnings", { params: pages(args) });
    case "h1_get_payouts": return api("/hackers/payments/payouts", { params: pages(args) });
    case "h1_list_programs": return api("/hackers/programs", { params: pages(args) });
    case "h1_get_program": return api(`/hackers/programs/${handle}`);
    case "h1_get_program_scopes": return api(`/hackers/programs/${handle}/structured_scopes`, { params: {
      "filter[id__gt]": args.id_greater_than, "filter[created_at__gt]": args.created_after,
      "filter[updated_at__gt]": args.updated_after, ...pages(args),
    } });
    case "h1_get_scope_exclusions": return api(`/hackers/programs/${handle}/scope_exclusions`);
    case "h1_get_program_weaknesses": return api(`/hackers/programs/${handle}/weaknesses`, { params: pages(args) });
    case "h1_list_report_intents": return api("/hackers/report_intents", { params: pages(args) });
    case "h1_get_report_intent": return api(`/hackers/report_intents/${intentId}`);
    case "h1_create_report_intent": return api("/hackers/report_intents", { method: "POST", body: document("report-intent", args) });
    case "h1_update_report_intent": return api(`/hackers/report_intents/${intentId}`, { method: "PATCH", body: document("report-intent", { description: args.description }) });
    case "h1_delete_report_intent": return api(`/hackers/report_intents/${intentId}`, { method: "DELETE" });
    case "h1_submit_report_intent": return api(`/hackers/report_intents/${intentId}/submit`, { method: "POST" });
    case "h1_list_report_intent_attachments": return api(`/hackers/report_intents/${intentId}/attachments`);
    case "h1_upload_report_intent_attachments": return upload(args);
    case "h1_delete_report_intent_attachment": return api(`/hackers/report_intents/${intentId}/attachments/${part(args.attachment_id)}`, { method: "DELETE" });
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server({ name: "hackerone-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await invoke(params.name, params.arguments ?? {}), null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error("HackerOne MCP server running");
