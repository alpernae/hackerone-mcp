# HackerOne MCP Server

An MCP (Model Context Protocol) server that connects Claude, Codex, and other MCP clients to the HackerOne Hackers API.

## Tools Available

| Tool | Description |
|------|-------------|
| `h1_list_reports` | List your reports, filterable by program, state, severity, page |
| `h1_get_report` | Get full details of a specific report by ID |
| `h1_get_program_scopes` | Get in-scope and out-of-scope assets for a program |
| `h1_get_program` | Get program details (policy, bounties, response stats) |
| `h1_list_programs` | List programs you have access to |

---

## Setup

### 1. Install dependencies

```bash
cd hackerone-mcp
npm install
```

### 2. Get your HackerOne API credentials

1. Go to https://hackerone.com/settings/api_token/edit
2. Create a new API token
3. Note your **username** and the generated **token**

---

## Configuration

### Claude Desktop

Edit your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hackerone": {
      "command": "node",
      "args": ["/absolute/path/to/hackerone-mcp/index.js"],
      "env": {
        "HACKERONE_API_USERNAME": "your_api_token_identifier",
        "HACKERONE_API_TOKEN": "your_api_token"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

---

### Claude Code (CLI)

Run once to add the MCP server to your Claude Code config:

```bash
claude mcp add hackerone \
  -e HACKERONE_API_USERNAME=your_api_token_identifier \
  -e HACKERONE_API_TOKEN=your_api_token \
  -- node /absolute/path/to/hackerone-mcp/index.js
```

Or set credentials as shell environment variables first:

```bash
export HACKERONE_API_USERNAME=your_api_token_identifier
export HACKERONE_API_TOKEN=your_api_token

claude mcp add hackerone -- node /absolute/path/to/hackerone-mcp/index.js
```

Verify it's registered:
```bash
claude mcp list
```

---

### Codex CLI

Run once to add the MCP server to Codex:

```bash
codex mcp add hackerone \
  --env HACKERONE_API_USERNAME=your_api_token_identifier \
  --env HACKERONE_API_TOKEN=your_api_token \
  -- node /absolute/path/to/hackerone-mcp/index.js
```

Or configure it directly in `config.toml`:

- **macOS/Linux:** `~/.codex/config.toml`
- **Windows:** `%USERPROFILE%\.codex\config.toml`

```toml
[mcp_servers.hackerone]
command = "node"
args = ["/absolute/path/to/hackerone-mcp/index.js"]

[mcp_servers.hackerone.env]
HACKERONE_API_USERNAME = "your_api_token_identifier"
HACKERONE_API_TOKEN = "your_api_token"
```

Verify it's registered:

```bash
codex mcp list
```

In Codex TUI, run `/mcp` to view active MCP servers.

---

### Other MCP Clients (generic stdio)

Pass the environment variables when launching:

```bash
HACKERONE_API_USERNAME=your_api_token_identifier \
HACKERONE_API_TOKEN=your_api_token \
node /path/to/hackerone-mcp/index.js
```

Or configure your client's MCP settings with:
- **command:** `node`
- **args:** `["/path/to/hackerone-mcp/index.js"]`
- **env:** `{ "HACKERONE_API_USERNAME": "...", "HACKERONE_API_TOKEN": "..." }`

---

## Example prompts

Once connected, you can ask your MCP client (Claude, Codex, etc.) things like:

- *"List my open HackerOne reports"*
- *"Show me all critical severity reports"*
- *"Get the full details of report 12345"*
- *"What's in scope for the nodejs program?"*
- *"Show me the policy and bounty info for the security program"*
- *"List all programs I have access to"*

---

## Security Notes

- **Never hardcode** your API token in the source files
- Always use environment variables or your client's secrets manager
- Your API token provides full access to your HackerOne account — treat it like a password
