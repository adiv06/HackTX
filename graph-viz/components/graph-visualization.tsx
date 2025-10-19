
"use client"

import { useEffect, useRef, useState } from "react"
import * as d3 from "d3"
import type { Node, Edge } from "@/lib/types"
import { Card } from "@/components/ui/card"

interface GraphVisualizationProps {
  nodes: Node[]
  edges: Edge[]
  nodeSizeScaling?: number // 1 = no effect, 5 = moderate, 10 = huge effect
}

interface D3Node extends d3.SimulationNodeDatum {
  id: number
  title: string
  papers: string[]
  relevance: number
  summary?: string
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  reasoning: string
}

export function GraphVisualization({ nodes, edges, nodeSizeScaling = 5 }: GraphVisualizationProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

    // Start EMPTY so you can visibly confirm server data is driving the graph.
  const [dataNodes, setDataNodes] = useState<Node[]>([])
  const [dataEdges, setDataEdges] = useState<Edge[]>([])

  // Fetch status (to show in UI)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // currently selected node for click-toggle logic
  const selectedNodeRef = useRef<Node | null>(null)

  // preserve node positions across rebuilds so the graph doesn't jump
  const prevPosRef = useRef<Map<number, { x: number; y: number }>>(new Map())

  //  your Lambda endpoint returning { nodes, edges }
  const LAMBDA_URL = "https://vnh1q99dvc.execute-api.us-east-1.amazonaws.com/data"

    // optimization state + endpoint
  const [isOptimizing, setIsOptimizing] = useState(false)
  const OPTIMIZE_URL = "https://vnh1q99dvc.execute-api.us-east-1.amazonaws.com/optimize"


    const handleOptimize = async () => {
    if (isOptimizing) return
    setIsOptimizing(true)

    try {
      // 1) trigger optimization
      const res = await fetch(OPTIMIZE_URL, { method: "POST" })
      if (!res.ok) throw new Error(`Optimize failed: ${res.status} ${res.statusText}`)

      // 2) on success, refetch latest graph data and merge in
      const edgeKey = (e: Edge) => {
        const a = Math.min(e.nodeID1, e.nodeID2)
        const b = Math.max(e.nodeID1, e.nodeID2)
        return `${a}-${b}`
      }

      const getRes = await fetch(LAMBDA_URL, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        headers: { "pragma": "no-cache", "cache-control": "no-cache" },
      })
      if (!getRes.ok) throw new Error(`Refresh failed: ${getRes.status} ${getRes.statusText}`)

      const raw = await getRes.json()
      const json = raw.data ?? raw

      if (!Array.isArray(json?.nodes) || !Array.isArray(json?.edges)) {
        throw new Error("Unexpected JSON shape after optimize")
      }

      // merge nodes (new overwrites old, preserve existing fields like summary)
      setDataNodes(prev => {
        const byId = new Map<number, Node>(prev.map(n => [n.id, n]))
        for (const n of json.nodes) {
          const old = byId.get(n.id)
          byId.set(n.id, old ? { ...old, ...n } : n)
        }
        return Array.from(byId.values())
      })

      // merge edges (dedupe undirected)
      setDataEdges(prev => {
        const seen = new Set(prev.map(edgeKey))
        const merged = [...prev]
        for (const e of json.edges as Edge[]) {
          const k = edgeKey(e)
          if (!seen.has(k)) { merged.push(e); seen.add(k) }
        }
        return merged
      })
    } catch (err) {
      console.error("[optimize] error:", err)
    } finally {
      setIsOptimizing(false)
    }
  }




  useEffect(() => {
    let isMounted = true

    // Normalize an undirected edge so A-B and B-A dedupe to the same key.
    const edgeKey = (e: Edge) => {
      const a = Math.min(e.nodeID1, e.nodeID2)
      const b = Math.max(e.nodeID1, e.nodeID2)
      return `${a}-${b}`
    }

    const load = async () => {
      try {
        setFetchError(null)
        const res = await fetch(LAMBDA_URL, {
          method: "GET",
          mode: "cors",
          cache: "no-store",
          headers: {
            "pragma": "no-cache",
            "cache-control": "no-cache",
          },
        })
        if (!res.ok) {
          console.warn("[graph] fetch not ok:", res.status, res.statusText)
          return
        }
        const raw = await res.json()
        const json = raw.data ?? raw  // unwraps { data: { nodes, edges } }

        if (!isMounted) return

        if (!json || !Array.isArray(json.nodes) || !Array.isArray(json.edges)) {
          console.warn("[graph] unexpected JSON shape:", json)
          setFetchError("Unexpected JSON shape (needs {nodes,edges})")
          return
        }

        // Merge nodes by id (new overwrites old)
        setDataNodes(prev => {
  const byId = new Map<number, Node>(prev.map(n => [n.id, n]))
  for (const n of json.nodes) {
    const old = byId.get(n.id)
    // merge to keep existing fields (like summary) if the new object doesn't include them
    byId.set(n.id, old ? { ...old, ...n } : n)
  }
  const out = Array.from(byId.values())
  console.log(`[graph] nodes: ${prev.length} -> ${out.length}`)
  return out
})


        // Merge edges by normalized key (append only brand-new edges)
        setDataEdges(prev => {
          const seen = new Set(prev.map(edgeKey))
          const merged = [...prev]
          let added = 0
          for (const e of json.edges) {
            const k = edgeKey(e)
            if (!seen.has(k)) {
              merged.push(e)
              seen.add(k)
              added++
            }
          }
          console.log(`[graph] edges: +${added} (total ${merged.length})`)
          return merged
        })

        setLastUpdated(new Date())
      } catch (err: any) {
        console.error("[graph] fetch error:", err)
        setFetchError(err?.message ?? "Fetch failed")
      }
    }

    load()                                // initial fetch
    const id = setInterval(load, 10_000)  // poll every 10s
    return () => {
      isMounted = false
      clearInterval(id)
    }
  }, [LAMBDA_URL])




    useEffect(() => {
    selectedNodeRef.current = selectedNode
  }, [selectedNode])



  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    updateDimensions()
    window.addEventListener("resize", updateDimensions)
    return () => window.removeEventListener("resize", updateDimensions)
  }, [])

    useEffect(() => {
    if (!svgRef.current || dimensions.width === 0) return

    const svg = d3.select(svgRef.current)
    svg.selectAll("*").remove()

    const width = dimensions.width
    const height = dimensions.height

    // ---- use live, merged data ----
    const nodeDegrees = new Map<number, number>()
    dataNodes.forEach((node) => nodeDegrees.set(node.id, 0))
    dataEdges.forEach((edge) => {
      nodeDegrees.set(edge.nodeID1, (nodeDegrees.get(edge.nodeID1) || 0) + 1)
      nodeDegrees.set(edge.nodeID2, (nodeDegrees.get(edge.nodeID2) || 0) + 1)
    })

    const baseRadius = 40
    const getNodeRadius = (nodeId: number) => {
      const degree = nodeDegrees.get(nodeId) || 0
      return baseRadius + degree * nodeSizeScaling
    }

    // Seed from previous positions to avoid layout resets on updates
    const d3Nodes: D3Node[] = dataNodes.map((node) => {
      const prev = prevPosRef.current.get(node.id)
      return {
        ...node,
        x: prev?.x ?? width / 2,
        y: prev?.y ?? height / 2,
      }
    })

    const d3Links: D3Link[] = dataEdges.map((edge) => ({
      source: edge.nodeID1,
      target: edge.nodeID2,
      reasoning: edge.reasoning,
    }))

    const simulation = d3
      .forceSimulation(d3Nodes)
      .force(
        "link",
        d3
          .forceLink<D3Node, D3Link>(d3Links)
          .id((d) => d.id)
          .distance(200),
      )
      .force("charge", d3.forceManyBody().strength(-800))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide().radius((d) => getNodeRadius((d as D3Node).id) + 10),
      )

    const g = svg.append("g")

    const defs = svg.append("defs")
    const filter = defs.append("filter").attr("id", "glow")
    filter.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "coloredBlur")
    const feMerge = filter.append("feMerge")
    feMerge.append("feMergeNode").attr("in", "coloredBlur")
    feMerge.append("feMergeNode").attr("in", "SourceGraphic")

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 3])
      .on("zoom", (event) => {
        g.attr("transform", event.transform)
      })

    svg.call(zoom)

    const link = g
      .append("g")
      .selectAll("line")
      .data(d3Links)
      .join("line")
      .attr("stroke", "oklch(0.2 0 0)")
      .attr("stroke-width", 2)
      .attr("opacity", 0.6)

    const edgeDots = g
      .append("g")
      .selectAll("circle")
      .data(d3Links)
      .join("circle")
      .attr("r", 6)
      .attr("fill", "oklch(0.15 0 0)")
      .attr("cursor", "pointer")
      .attr("class", "edge-dot")
      .on("mouseenter", function (event, d) {
        d3.select(this).transition().duration(200).attr("r", 10).attr("fill", "oklch(0.6 0.2 270)")
        setHoveredEdge(d.reasoning)
      })
      .on("mouseleave", function () {
        d3.select(this).transition().duration(200).attr("r", 6).attr("fill", "oklch(0.15 0 0)")
        setHoveredEdge(null)
      })

    const node = g
      .append("g")
      .selectAll("circle")
      .data(d3Nodes)
      .join("circle")
      .attr("class", "node-circle")
      .attr("r", (d) => getNodeRadius(d.id))
      .attr("fill", "oklch(0.7014 0.1011 22.1)")
      .attr("stroke", "#f7d7d7")
      .attr("stroke-width", 3)
      .attr("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation()
        if (selectedNodeRef.current?.id === d.id) {
          setSelectedNode(null)
        } else {
          setSelectedNode(d as Node)
        }
      })
      .call(
        d3.drag<SVGCircleElement, D3Node>().on("start", dragstarted).on("drag", dragged).on("end", dragended) as any,
      )

    const labels = g
      .append("g")
      .selectAll("text")
      .data(d3Nodes)
      .join("text")
      .attr("font-size", 11)
      .attr("font-weight", 600)
      .attr("fill", "oklch(0.98 0 0)")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .attr("pointer-events", "none")
      .style("user-select", "none")
      .each(function (d) {
        const text = d3.select(this);
        const maxWidth = getNodeRadius(d.id) * 1.6;
        const words = d.title.split(" ");
        const lineHeight = 1.1;

        text.text("");
        const measure = text.append("tspan").attr("x", 0).attr("visibility", "hidden");

        let line: string[] = [];
        const lines: string[] = [];

        words.forEach((w) => {
          const test = [...line, w].join(" ");
          measure.text(test);
          const width = (measure.node() as SVGTSpanElement).getComputedTextLength();

          if (width > maxWidth && line.length) {
            lines.push(line.join(" "));
            line = [w];
            measure.text(w);
          } else {
            line.push(w);
          }
        });

        if (line.length) lines.push(line.join(" "));
        measure.remove();

        const totalHeight = (lines.length - 1) * lineHeight;
        lines.forEach((l, i) => {
          const t = text.append("tspan").attr("x", 0).text(l);
          t.attr("dy", i === 0 ? `${-totalHeight / 2}em` : `${lineHeight}em`);
        });
      })

    svg.on("click", (event) => {
      if (event.target === svgRef.current) {
        setSelectedNode(null)
      }
    })

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as D3Node).x!)
        .attr("y1", (d) => (d.source as D3Node).y!)
        .attr("x2", (d) => (d.target as D3Node).x!)
        .attr("y2", (d) => (d.target as D3Node).y!)

      edgeDots
        .attr("cx", (d) => ((d.source as D3Node).x! + (d.target as D3Node).x!) / 2)
        .attr("cy", (d) => ((d.source as D3Node).y! + (d.target as D3Node).y!) / 2)

      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!)
      labels.attr("transform", (d) => `translate(${d.x!},${d.y!})`)

      // Save positions for the next rebuild
      const map = new Map<number, { x: number; y: number }>()
      for (const nd of d3Nodes) map.set(nd.id, { x: nd.x ?? width / 2, y: nd.y ?? height / 2 })
      prevPosRef.current = map
    })

    function dragstarted(event: d3.D3DragEvent<SVGCircleElement, D3Node, D3Node>) {
      if (!event.active) simulation.alphaTarget(0.3).restart()
      event.subject.fx = event.subject.x
      event.subject.fy = event.subject.y
    }

    function dragged(event: d3.D3DragEvent<SVGCircleElement, D3Node, D3Node>) {
      event.subject.fx = event.x
      event.subject.fy = event.y
    }

    function dragended(event: d3.D3DragEvent<SVGCircleElement, D3Node, D3Node>) {
      if (!event.active) simulation.alphaTarget(0)
      event.subject.fx = null
      event.subject.fy = null
    }

    return () => {
      simulation.stop()
    }
  }, [dataNodes, dataEdges, dimensions, nodeSizeScaling])


  useEffect(() => {
    if (!svgRef.current) return

    const svg = d3.select(svgRef.current)

    svg.selectAll(".node-circle").each(function (d) {
      const nodeData = d as D3Node
      const circle = d3.select(this)

      if (selectedNode?.id === nodeData.id) {
        circle
          .transition()
          .duration(200)
          .attr("filter", "url(#glow)")
          .attr("stroke", "#f29b9b")
          .attr("stroke-width", 5)
      } else {
        circle
          .transition()
          .duration(200)
          .attr("filter", null)
          .attr("stroke", "#f7d7d7")
          .attr("stroke-width", 3)
      }
    })
  }, [selectedNode])

  return (
    <div className="relative w-full h-screen bg-white">
      <svg ref={svgRef} width={dimensions.width} height={dimensions.height} className="w-full h-full" />

      <div className="absolute top-6 left-6 right-6 pointer-events-none">
        <div className="max-w-md">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 text-balance">Research Network Graph</h1>
          <p className="text-sm text-gray-600">
            Click nodes to see details • Hover over edge dots for relationships • Drag nodes to rearrange
          </p>
          <p className="text-xs mt-1 text-gray-500">
            Source: <span className="font-medium">{lastUpdated ? "Lambda" : "waiting…"}</span>
            {lastUpdated && (
              <span> • updated {lastUpdated.toLocaleTimeString()}</span>
            )}
            {fetchError && (
              <span className="text-red-600"> • error: {fetchError}</span>
            )}
          </p>
        </div>
      </div>


      {(selectedNode || hoveredEdge) && (
  <Card className="absolute bottom-6 left-6 right-6 max-w-2xl p-6 bg-white border-gray-200 shadow-2xl pointer-events-auto">
    {selectedNode && (
      <div>
        <h3 className="text-xl font-bold text-gray-900 mb-2">{selectedNode.title}</h3>

        {/* show summary if present */}
        {selectedNode.summary && (
          <p className="text-sm text-gray-700 mb-3">{selectedNode.summary}</p>
        )}

        <div className="space-y-2">
          <div>
            <span className="text-sm font-semibold text-gray-700">Papers:</span>
            <ul className="mt-1 space-y-1">
              {selectedNode.papers.map((paper, idx) => (
                <li key={idx} className="text-sm text-blue-600 hover:text-blue-800 transition-colors">
                  <a href={paper} target="_blank" rel="noopener noreferrer" className="underline">
                    {paper}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )}

    {hoveredEdge && !selectedNode && (
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-1">Relationship</h3>
        <p className="text-base text-gray-900">{hoveredEdge}</p>
      </div>
    )}
  </Card>
)}


      <div className="absolute bottom-6 right-6 z-10 pointer-events-auto">
        <button
          onClick={handleOptimize}
          className="px-12 py-6 rounded-xl shadow-lg bg-black text-white text-lg font-semibold hover:opacity-90 active:scale-95 transition-transform duration-150"
          aria-label="Optimize flowchart"
        >
          Optimize
        </button>
      </div>


            {isOptimizing && (
        <div className="absolute inset-0 bg-white/70 backdrop-blur-[2px] flex items-center justify-center">
          <div className="animate-pulse text-gray-800 text-sm font-medium">
            Optimizing flowchart…
          </div>
        </div>
      )}





    </div>
  )
}
