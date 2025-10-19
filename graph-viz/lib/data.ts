import type { Node, Edge } from "./types"

export const nodes: Node[] = [
  {
    id: 1,
    title: "Graph Neural Networks",
    papers: ["https://arxiv.org/abs/1810.00826"],
    relevance: 0.9,
  },
  {
    id: 2,
    title: "Transformer Models",
    papers: ["https://arxiv.org/abs/1706.03762"],
    relevance: 0.85,
  },
  {
    id: 3,
    title: "Convolutional Networks",
    papers: ["https://arxiv.org/abs/1409.1556"],
    relevance: 0.75,
  },
  {
    id: 4,
    title: "Reinforcement Learning",
    papers: ["https://arxiv.org/abs/1312.5602"],
    relevance: 0.8,
  },
  {
    id: 5,
    title: "Self-Supervised Learning",
    papers: ["https://arxiv.org/abs/1905.09272"],
    relevance: 0.88,
  },
  {
    id: 6,
    title: "Computer Vision",
    papers: ["https://arxiv.org/abs/1512.03385"],
    relevance: 0.7,
  },
  {
    id: 7,
    title: "Natural Language Processing",
    papers: ["https://arxiv.org/abs/2005.14165"],
    relevance: 0.82,
  },
  {
    id: 8,
    title: "Generative Models",
    papers: ["https://arxiv.org/abs/1406.2661", "https://onikh.github.io"],
    relevance: 0.9,
  },
]

export const edges: Edge[] = [
  { nodeID1: 1, nodeID2: 2, reasoning: "Transformers and GNNs both capture relational structure." },
  { nodeID1: 1, nodeID2: 5, reasoning: "GNNs benefit from self-supervised pretraining." },
  { nodeID1: 2, nodeID2: 7, reasoning: "Transformers are the backbone of most NLP models." },
  { nodeID1: 2, nodeID2: 4, reasoning: "Transformers combined with RL enable advanced reasoning." },
  { nodeID1: 3, nodeID2: 6, reasoning: "CNNs dominate computer vision tasks." },
  { nodeID1: 5, nodeID2: 8, reasoning: "Self-supervised learning powers generative models." },
  { nodeID1: 4, nodeID2: 8, reasoning: "RL agents use generative world models for planning." },
  { nodeID1: 7, nodeID2: 8, reasoning: "Text-to-image models blend NLP and generation." },
  { nodeID1: 1, nodeID2: 3, reasoning: "Both learn over graph-like spatial patterns." },
  { nodeID1: 5, nodeID2: 7, reasoning: "Language models trained with self-supervised objectives." },
]
