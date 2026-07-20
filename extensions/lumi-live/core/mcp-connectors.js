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
  }),
]);

export function getMcpConnector(connectorId) {
  return MCP_CONNECTORS.find((connector) => connector.id === connectorId) || null;
}
