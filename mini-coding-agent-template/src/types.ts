import { z } from "zod";



export const AgentTask = z.object({
    prompt: z.string(),
    context: z.array(z.string()),
    maxIterations: z.number(),
    agentId: z.string()
})
export type AgentTask = z.infer<typeof AgentTask>


export const ContextArtifactType = z.union([
    z.literal("text"), z.literal("reference")
]);
export type ContextArtifactType = z.infer<typeof ContextArtifactType>


export const ContextArtifact = z.object({
    type: ContextArtifactType,
    value: z.string(),
})
export type ContextArtifact = z.infer<typeof ContextArtifact>
