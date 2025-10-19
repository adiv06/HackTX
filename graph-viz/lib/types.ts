export interface Node {
  id: number
  title: string
  papers: string[]
  relevance: number
}

export interface Edge {
  nodeID1: number
  nodeID2: number
  reasoning: string
}
