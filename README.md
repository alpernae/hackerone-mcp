# HackerOne MCP Server

An MCP (Model Context Protocol) server that connects Claude, Claude codex and other mcp clients to the HackerOne Hackers API.

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
        "HACKERONE_USERNAME": "your_h1_username",
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
  -e HACKERONE_USERNAME=your_h1_username \
  -e HACKERONE_API_TOKEN=your_api_token \
  -- node /absolute/path/to/hackerone-mcp/index.js
```

Or set credentials as shell environment variables first:

```bash
export HACKERONE_USERNAME=your_h1_username
export HACKERONE_API_TOKEN=your_api_token

claude mcp add hackerone -- node /absolute/path/to/hackerone-mcp/index.js
```

Verify it's registered:
```bash
claude mcp list
```

---

### Other MCP Clients (generic stdio)

Pass the environment variables when launching:

```bash
HACKERONE_USERNAME=your_h1_username \
HACKERONE_API_TOKEN=your_api_token \
node /path/to/hackerone-mcp/index.js
```

Or configure your client's MCP settings with:
- **command:** `node`
- **args:** `["/path/to/hackerone-mcp/index.js"]`
- **env:** `{ "HACKERONE_USERNAME": "...", "HACKERONE_API_TOKEN": "..." }`

---

## Example prompts

Once connected, you can ask Claude things like:

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
