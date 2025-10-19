import fetch from "node-fetch";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const KEY = process.env.ITEM_KEY || "latest";

export function cors(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // tighten in prod
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    },
    body: JSON.stringify(payload)
  };
}

/** Read the JSON blob from DynamoDB (single item). */
export async function readFromDynamo() {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: KEY } }
  }));
  if (!res.Item) return null;
  return JSON.parse(res.Item.payload.S);
}

/** Overwrite the JSON blob to DynamoDB (single item). */
export async function writeToDynamo(jsonPayload) {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: KEY },
      payload: { S: JSON.stringify(jsonPayload) }
    }
  }));
}

/** Low-level Gemini call that forces JSON-only output. */
export async function geminiJSON(model, apiKey, instruction, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: `${instruction}\n\nPAYLOAD:\n${JSON.stringify(payload)}` }]}]
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("Gemini returned empty");
  const jsonText = text.replace(/^```json\s*|\s*```$/g, "");
  return JSON.parse(jsonText);
}

/** Cluster items by description with Gemini. */
export async function geminiCluster(items) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const instruction = `
You are a JSON-only API. Group items by semantic similarity of "description".
Return strictly this JSON:

{
  "clusters": [
    { "description": "short label", "memberIds": ["id1","id2"], "mergedSummary": "2-3 sentences" }
  ],
  "unclustered": ["idX"]
}

No commentary.`;

  const lite = items.map(i => ({
    id: String(i.id ?? i._id ?? i.key),
    description: i.description ?? ""
  }));
  return geminiJSON(model, apiKey, instruction, lite);
}

/** Optional: Google Scholar via SerpApi (skip if no key). */
export async function scholarSearch(query, limit = 3) {
  const key = process.env.SERPAPI_KEY;
  if (!key) return []; // skip enrichment if not configured
  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(query)}&num=${limit}&api_key=${key}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  const list = j.organic_results || [];
  return list.slice(0, limit).map(p => ({
    title: p.title,
    url: p.link,
    snippet: p.snippet,
    year: p.publication_info?.year,
    authors: p.publication_info?.authors?.map(a => a.name) ?? []
  }));
}
