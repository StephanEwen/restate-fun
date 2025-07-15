import { z } from "zod";

// ----------------------------------------------------------------------------
//  task types
// ----------------------------------------------------------------------------

export const Task = z.object({
    name: z.string(),
    workDef: z.string()
})
export type Task = z.infer<typeof Task>

export const TaskResult = z.object({
    task: Task,
    resource: z.string()
})
export type TaskResult = z.infer<typeof TaskResult>

export const TaskBundle = z.object({
    tasksToRun: z.array(Task),
    completedResouces: z.array(TaskResult)
})
export type TaskBundle = z.infer<typeof TaskBundle>


