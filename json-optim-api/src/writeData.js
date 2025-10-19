import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const KEY = process.env.ITEM_KEY || "latest";
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN; // set at deploy time

const cors = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",          // tighten to your domain(s) in prod
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

function isValidGraphPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const { nodes, edges } = payload;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;
  const nodesOk = nodes.every(n =>
    n && typeof n.id === "number" &&
    typeof n.title === "string" &&
    typeof n.summary === "string" &&
    Array.isArray(n.papers) && n.papers.every(p => typeof p === "string") &&
    typeof n.relevance === "number"
  );
  const edgesOk = edges.every(e =>
    e && typeof e.nodeID1 === "number" &&
    typeof e.nodeID2 === "number" &&
    typeof e.reasoning === "string"
  );
  return nodesOk && edgesOk;
}

export const handler = async (event) => {
  try {
    // Auth: simple bearer token (replace later with Cognito if you prefer)
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!UPLOAD_TOKEN || token !== UPLOAD_TOKEN) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    if (!event.body) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing body" }) };
    }

    let payload;
    try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    if (!isValidGraphPayload(payload)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid {nodes, edges} schema" }) };
    }

    // Store as a JSON string in "payload" attribute
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: KEY }, payload: { S: JSON.stringify(payload) } }
    }));

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Failed to write" }) };
  }
};
