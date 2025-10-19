import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const KEY = process.env.ITEM_KEY || "latest";

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*", // tighten in prod
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

// minimal runtime guard to ensure {nodes, edges} with required fields
function isValidGraphPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const { nodes, edges } = payload;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;

  const nodesOk = nodes.every(n =>
    n &&
    typeof n.id === "number" &&
    typeof n.title === "string" &&
    Array.isArray(n.papers) &&
    n.papers.every(p => typeof p === "string") &&
    typeof n.relevance === "number"
  );

  const edgesOk = edges.every(e =>
    e &&
    typeof e.nodeID1 === "number" &&
    typeof e.nodeID2 === "number" &&
    typeof e.reasoning === "string"
  );

  return nodesOk && edgesOk;
}

export const handler = async () => {
  try {
    const res = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: KEY } }
    }));

    if (!res.Item) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          data: { nodes: [], edges: [] },
          note: "No data found in DynamoDB yet."
        })
      };
    }

    const payloadStr = res.Item.payload?.S ?? "null";
    let payload;
    try { payload = JSON.parse(payloadStr); } catch { payload = null; }

    if (!isValidGraphPayload(payload)) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Stored payload is not a valid {nodes, edges} graph per schema."
        })
      };
    }

    // Success: return GraphPayload
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ data: payload })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to read data" })
    };
  }
};
