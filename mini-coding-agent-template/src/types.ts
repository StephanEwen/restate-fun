import { z } from "zod";


export const Entry = z.object({
    role: z.union([z.literal("agent"), z.literal("user")]),
    message: z.string(),
    artifactRef: z.string().optional() // optionally link to file in S3
})
export type Entry = z.infer<typeof Entry>


export const AgentTask = z.object({
    prompt: z.string(),
    context: z.array(Entry),
    maxIterations: z.number(),
    agentId: z.string()
})
export type AgentTask = z.infer<typeof AgentTask>


export const ContextArtifact = z.object({
    text: z.string(),
    reference: z.string().optional()
})
export type ContextArtifact = z.infer<typeof ContextArtifact>
