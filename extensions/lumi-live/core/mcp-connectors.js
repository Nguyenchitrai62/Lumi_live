export const MCP_CONNECTORS = Object.freeze([
  Object.freeze({
    id: "notion",
    name: "Notion",
    icon: "../icons/connectors/notion.svg",
    description: "Search, read, and update the Notion workspace you authorize.",
    endpoint: "https://mcp.notion.com/mcp",
    auth: "oauth-dcr",
  }),
  Object.freeze({
    id: "jira",
    name: "Jira",
    icon: "../icons/connectors/jira.svg",
    description: "Search, read, create, and update Jira Cloud work you authorize.",
    endpoint: "https://mcp.atlassian.com/v1/mcp/authv2",
    auth: "oauth-dcr",
  }),
  Object.freeze({
    id: "redmine",
    name: "Redmine",
    icon: "../icons/connectors/redmine.svg",
    description: "Read projects and issues, then create or update work with approval.",
    fields: Object.freeze([
      Object.freeze({
        name: "baseUrl",
        label: "Redmine URL",
        type: "url",
        placeholder: "https://redmine.example.com",
        autocomplete: "url",
      }),
      Object.freeze({
        name: "apiKey",
        label: "Redmine API key",
        type: "password",
        placeholder: "Paste the key from My account",
        autocomplete: "off",
      }),
    ]),
    modalDescription: "Enter any link from your Redmine server and the API key from My account.",
    modalNote: "Links to projects, issues, and time entries are reduced to the Redmine base address automatically.",
    checkingLabel: "Checking Redmine...",
    checkingMessage: "Validating the URL and API key...",
  }),
  Object.freeze({
    id: "hicas",
    name: "Hicas",
    icon: "../icons/connectors/hicas.png",
    description: "Connect a Hicas MCP server with its MCP key.",
    fields: Object.freeze([
      Object.freeze({
        name: "baseUrl",
        label: "Hicas MCP URL",
        type: "url",
        placeholder: "https://mcp-hawee.hicas.vn/mcp",
        autocomplete: "url",
      }),
      Object.freeze({
        name: "mcpKey",
        label: "Hicas MCP key",
        type: "password",
        placeholder: "Paste your MCP key",
        autocomplete: "off",
      }),
    ]),
    modalDescription: "Enter the Hicas MCP endpoint and its MCP key.",
    modalNote: "Use https://mcp-hawee.hicas.vn/mcp. Lumi appends the key as MCP_KEY automatically and keeps it out of the displayed URL.",
    checkingLabel: "Checking Hicas...",
    checkingMessage: "Validating the URL and MCP key...",
  }),
]);

export function getMcpConnector(connectorId) {
  return MCP_CONNECTORS.find((connector) => connector.id === connectorId) || null;
}
