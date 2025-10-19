// src/optimize.js
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";


const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const KEY = process.env.ITEM_KEY || "latest";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const S2_PAPERS_PER_NODE = Math.max(0, parseInt(process.env.S2_PAPERS_PER_NODE || "3", 10));

const cors = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};

// ---------- Dynamo helpers ----------
async function readGraph() {
  const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: KEY } } }));
  if (!res.Item) return null;
  try { return JSON.parse(res.Item.payload.S); } catch { return null; }
}
async function writeGraph(graph) {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: { pk: { S: KEY }, payload: { S: JSON.stringify(graph) } }
  }));
}

// ---------- validation ----------
function isGraph(x) {
  if (!x || typeof x !== "object") return false;
  const { nodes, edges } = x;
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

// ---------- OpenAI merge (Responses API w/ text.format) ----------
async function getMergeGroups(nodes) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            memberIds: { type: "array", items: { type: "number" }, minItems: 1 },
            reasoning: { type: "string" },
            summary: { type: "string" }  
          },
          required: ["label", "memberIds", "summary", "reasoning"]
        }
      }
    },
    required: ["groups"]
  };

  const sys = `You will receive a list of Nodes with {id:number, title:string, relevance:number}. Cluster nodes that are essentially the same topic. Only create a group when items are very similar.
For each cluster, return:
 - label: short theme name
 - memberIds: the ids of nodes in this cluster (2 or more)
 - summary: a concise 1–2 sentence summary of the cluster topic
 - reasoning: (optional) short rationale
Output JSON strictly following the supplied JSON Schema. No extra text.`;

  const user = {
    nodes: nodes.map(n => ({ id: n.id, title: n.title, relevance: n.relevance }))
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(user) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "MergeGroups",
          schema
        },
        
      }
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${t}`);
  }

  const data = await resp.json();

  // Flexible extraction across Responses payload shapes
  let text = data.output_text;
  if (!text && Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) {
    text = data.output[0].content[0].text;
  }
  if (!text) throw new Error("OpenAI returned no structured text");

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("Invalid JSON from OpenAI"); }
  return parsed.groups || [];
}


// ---------- merge + edge rewire ----------
function mergeNodes(nodes, groups) {
  const idSet = new Set(nodes.map(n => n.id));
  const assigned = new Set();
  const idMap = new Map();
  const mergedNodes = [];

  for (const g of groups) {
    if (!Array.isArray(g.memberIds) || g.memberIds.length < 2) continue;
    const members = g.memberIds.filter(id => idSet.has(id));
    if (members.length < 2) continue;

    members.forEach(id => assigned.add(id));
    const mergedId = Math.min(...members);
    const title = (g.label || `Merged ${members.join("+")}`).trim();
    const summary = (g.summary || title).trim();
    const relevance = Math.max(...members.map(id => nodes.find(n => n.id === id)?.relevance ?? 0));

    mergedNodes.push({ id: mergedId, title, summary, papers: [], relevance });
    members.forEach(id => idMap.set(id, mergedId));
  }

  const passthrough = nodes.filter(n => !assigned.has(n.id)).map(n => {
    idMap.set(n.id, n.id);
    return n;
  });

  const byId = new Map();
  for (const n of [...mergedNodes, ...passthrough]) {
    const prev = byId.get(n.id);
    if (!prev || (n.relevance ?? 0) > (prev.relevance ?? 0)) byId.set(n.id, n);
  }
  return { nodes: [...byId.values()], idMap };
}

function rewireEdges(edges, idMap) {
  const out = [];
  const seen = new Set();
  for (const e of edges) {
    const a = idMap.get(e.nodeID1);
    const b = idMap.get(e.nodeID2);
    if (a == null || b == null) continue;
    if (a === b) continue; // drop self-loop after merge
    const x = Math.min(a, b), y = Math.max(a, b);
    const k = `${x}-${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ nodeID1: x, nodeID2: y, reasoning: e.reasoning });
  }
  return out;
}

// ---------- OpenAlex (free) ----------
async function findOpenAlex(topic, limit) {
  if (!limit || limit <= 0) return [];
  const q = (topic || "").trim();
  if (!q) return [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  // Filter to works; best fields are display_name + primary_location/source
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${limit}`;
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "json-optim-api/1.0 (contact@example.com)" }
    });
    if (!r.ok) return [];
    const j = await r.json();
    const data = Array.isArray(j?.results) ? j.results : [];
    // Prefer open access / primary URLs; fallback to DOI or OpenAlex page
    const links = data.map(w =>
      w?.primary_location?.landing_page_url ||
      w?.primary_location?.pdf_url ||
      (Array.isArray(w?.locations) && w.locations.find(l => l.landing_page_url)?.landing_page_url) ||
      (w?.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi.org\//i,'')}` : null) ||
      (w?.id ? `https://openalex.org/${(w.id+'').split('/').pop()}` : null)
    ).filter(Boolean);
    return links.slice(0, limit);
  } catch { return []; } finally { clearTimeout(t); }
}

// ---------- arXiv fallback ----------
async function findArxiv(topic, limit) {
  if (!limit || limit <= 0) return [];
  const q = (topic || "").trim();
  if (!q) return [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${limit}`;
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "json-optim-api/1.0" } });
    if (!r.ok) return [];
    const xml = await r.text();
    const out = [];
    const entryRegex = /<entry>[\s\S]*?<\/entry>/g;
    const linkRegex = /<link[^>]*?rel="alternate"[^>]*?href="([^"]+)"/i;
    let m;
    while ((m = entryRegex.exec(xml)) && out.length < limit) {
      const block = m[0];
      const lm = linkRegex.exec(block);
      if (lm && lm[1]) out.push(lm[1]);
    }
    return out;
  } catch { return []; } finally { clearTimeout(t); }
}

// ---------- SerpAPI (Google Scholar) – optional, needs SERPAPI_KEY ----------
async function findScholarSerpAPI(topic, limit) {
  const key = process.env.SERPAPI_KEY;
  if (!key || !limit || limit <= 0) return [];
  const q = (topic || "").trim();
  if (!q) return [];
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(q)}&num=${limit}&api_key=${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const results = Array.isArray(j?.organic_results) ? j.organic_results : [];
    // Prefer result.link; fallback to any available source link
    const links = results.map(o =>
      o?.link ||
      (Array.isArray(o?.resources) && o.resources.find(x => x.link)?.link) ||
      null
    ).filter(Boolean);
    return links.slice(0, limit);
  } catch { return []; } finally { clearTimeout(t); }
}



// ---------- handler ----------
export const handler = async () => {
  try {
    const graph = await readGraph();
    if (!isGraph(graph)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Stored payload is not a valid {nodes, edges} graph." }) };
    }
    console.log("OPT start", {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    model: OPENAI_MODEL,
    s2: S2_PAPERS_PER_NODE
    });
    // Back-compat: ensure every node has a summary
    for (const n of graph.nodes) {
      if (typeof n.summary !== "string") n.summary = n.title;
    }
    // 1) ask OpenAI for merge groups
    const groups = await getMergeGroups(graph.nodes);

    // 2) merge nodes + map ids
    const { nodes: mergedNodes, idMap } = mergeNodes(graph.nodes, groups);

    // 3) rewire edges
    const newEdges = rewireEdges(graph.edges, idMap);

    // 4) populate papers for each merged/passthrough node
    const labelByMergedId = new Map();
    for (const g of groups) {
      if (g.memberIds?.length >= 2) {
        labelByMergedId.set(Math.min(...g.memberIds), (g.label || "").trim());
      }
    }
    for (const n of mergedNodes) {
  const topic = labelByMergedId.get(n.id) || n.summary || n.title;

  let papers = await findOpenAlex(topic, S2_PAPERS_PER_NODE);
  if (!papers.length) papers = await findArxiv(topic, S2_PAPERS_PER_NODE);
  if (!papers.length) papers = await findScholarSerpAPI(topic, S2_PAPERS_PER_NODE);

  n.papers = papers;
  console.log("papers", { nodeId: n.id, topic, count: papers.length });
}

    const optimized = { nodes: mergedNodes, edges: newEdges };
    await writeGraph(optimized);

    return { statusCode: 200, headers: cors, body: JSON.stringify({ data: optimized }) };
  } catch (err) {
    console.error(err);
    // friendlier message if key is bad
    if (String(err).includes("invalid_api_key")) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "OpenAI API key invalid or missing" }) };
    }
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Optimize failed" }) };
  }
};
