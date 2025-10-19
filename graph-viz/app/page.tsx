import { GraphVisualization } from "@/components/graph-visualization"
import { nodes, edges } from "@/lib/data"

export default function Home() {
  // 1 = minimal effect, 5 = moderate effect, 10 = huge effect
  return <GraphVisualization nodes={nodes} edges={edges} nodeSizeScaling={5} />
}
