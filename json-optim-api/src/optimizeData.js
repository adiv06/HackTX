import { cors, readFromDynamo, writeToDynamo, geminiCluster, scholarSearch } from "./common.js";

/**
 * Reads the current JSON from DynamoDB, clusters/merges similar items by description (Gemini),
 * optionally enriches clusters with Google Scholar (if SERPAPI_KEY set),
 * then writes the optimized JSON back to the SAME DynamoDB item (overwriting it).
 */
export const handler = async (event) => {
  try {
    // Options: { articlesPerCluster?: number }
    const body = event.body ? JSON.parse(event.body) : {};
    const articlesPerCluster = Math.max(0, Math.min(parseInt(body.articlesPerCluster || "3", 10), 6));

    // 1) Load current JSON from DynamoDB
    const base = await readFromDynamo();
    if (!base) return cors(400, { error: "No base JSON found in DynamoDB. Seed it first." });

    // Base is expected to be an array (or {items: []}). Adjust if your shape differs.
    const items = Array.isArray(base) ? base : (base.items || []);
    if (!Array.isArray(items) || items.length === 0) {
      return cors(200, { data: base, note: "Nothing to optimize (no items)." });
    }

    // 2) Cluster with Gemini
    const { clusters = [], unclustered = [] } = await geminiCluster(items);

    // 3) Optional Scholar enrichment for each cluster label/topic
    const enrichedClusters = [];
    for (const c of clusters) {
      const topic = c.description || "Related research";
      const scholar = articlesPerCluster > 0 ? await scholarSearch(topic, articlesPerCluster) : [];
      enrichedClusters.push({
        label: topic,
        memberIds: c.memberIds,
        mergedSummary: c.mergedSummary,
        relatedArticles: scholar   // may be [] if SERPAPI_KEY not configured
      });
    }

    // 4) Build the new optimized document (shape it how your UI expects)
    const optimized = {
      clusters: enrichedClusters,
      unclustered,                // list of item IDs that didn't fit clusters
      generatedAt: new Date().toISOString()
    };

    // 5) OVERWRITE the dynamo item with optimized JSON
    await writeToDynamo(optimized);

    // 6) Return the optimized JSON
    return cors(200, { data: optimized, note: "Optimized JSON written to DynamoDB (overwrote previous content)." });
  } catch (e) {
    console.error(e);
    return cors(500, { error: "Optimization failed" });
  }
};
